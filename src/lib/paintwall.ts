// Wall-colour pipeline. Surfaces (the wall, plus optional ceiling, baseboards, trim, custom
// areas and no-paint areas) are detected on the original photo and repainted together; the
// straightened image is derived from the painted photo so every view matches.
//
// Rendering is single-flight and self-healing: one render runs at a time, only the newest
// result is saved, old images are deleted only after the new ones are stored, and any view
// whose painted image is missing or stale is simply re-rendered.
import { blobUrl, deleteBlob, getBlob } from './db';
import { applyH, invert3, multiply3, type Mat3 } from './geometry';
import { canvasToImg, imgToCanvas, loadImageElement, makeCanvas, warp, type Img } from './imaging';
import { storeCanvas } from './pipeline';
import { localScale, wallToSource } from './projection';
import { detectWallMask, maskPreview, repaint, upsampleMask, type MaskOptions, type SmallMask } from './recolor';
import { getProject, saveProject, setState } from './store';
import type { Pt, Quad, Surface, SurfaceKind, Vantage, Wall, WallPaint, Zone } from './types';

const imgCache = new Map<string, Promise<Img>>();

export function loadBlobImg(id: string): Promise<Img> {
  let p = imgCache.get(id);
  if (!p) {
    p = (async () => {
      const el = await loadImageElement((await blobUrl(id))!);
      const c = makeCanvas(el.naturalWidth, el.naturalHeight);
      c.getContext('2d')!.drawImage(el, 0, 0);
      return canvasToImg(c);
    })();
    imgCache.set(id, p);
    p.catch(() => imgCache.delete(id));
  }
  return p;
}

export const DEFAULT_PAINT: WallPaint = { hex: '', name: '', strength: 1, tolerance: 0.6 };

/** Known ceiling height, or a safe guess when the pinned area clearly spans floor to ceiling. */
export function ceilingHeightOf(wall: Wall): number | undefined {
  if (wall.ceilingHeight) return wall.ceilingHeight;
  if (wall.bottomAboveFloor <= 1 && wall.refH >= 84) return wall.refH + wall.bottomAboveFloor + 0.5;
  return undefined;
}

export const SURFACE_LABEL: Record<SurfaceKind | 'wall', string> = {
  wall: 'Wall', ceiling: 'Ceiling', baseboard: 'Baseboard', trim: 'Trim', area: 'Custom area', exclude: 'No-paint area',
};

export function hasAnyPaint(wall: Wall): boolean {
  return !!wall.paint?.hex || !!wall.surfaces?.some((s) => s.kind !== 'exclude' && s.paint?.hex);
}

/** Everything that affects the painted result, for knowing when a render is stale. */
export function paintKeyOf(wall: Wall, zones: Zone[]): string {
  return JSON.stringify([wall.sourceBlobId, wall.imageBlobId, wall.quad, wall.ceilingHeight, wall.paint, wall.surfaces, zones.filter((z) => z.noPaint)]);
}

// ---- Masks ----------------------------------------------------------------------------------

function zonePolys(zones: Zone[], H: Mat3): Pt[][] {
  return zones.filter((z) => z.noPaint).map((z) => [
    applyH(H, z.x, z.y), applyH(H, z.x + z.w, z.y), applyH(H, z.x + z.w, z.y + z.h), applyH(H, z.x, z.y + z.h),
  ]);
}

function expand(q: Pt[], k: number): Pt[] {
  const cx = q.reduce((a, p) => a + p.x, 0) / q.length, cy = q.reduce((a, p) => a + p.y, 0) / q.length;
  return q.map((p) => ({ x: cx + (p.x - cx) * k, y: cy + (p.y - cy) * k }));
}

function strokesAndTaps(paint: WallPaint, W: number, Hh: number) {
  return {
    taps: (paint.taps ?? []).map((p) => ({ x: p.x * W, y: p.y * Hh })),
    strokes: (paint.strokes ?? []).map((s) => ({ mode: s.mode, r: s.r * W, pts: s.pts.map((p) => ({ x: p.x * W, y: p.y * Hh })) })),
  };
}

/** Mask options for the main wall: whole wall plane between floor and ceiling, minus other surfaces. */
export function wallMaskOptions(wall: Wall, zones: Zone[], paint: WallPaint, srcW: number, srcH: number, otherQuads?: Pt[][]): MaskOptions {
  const H = wallToSource(wall);
  const floorY = wall.refH + wall.bottomAboveFloor;
  const ceil = ceilingHeightOf(wall);
  const top = ceil ? floorY - ceil : wall.y0;
  const clip = [applyH(H, wall.x0, top), applyH(H, wall.x1, top), applyH(H, wall.x1, floorY), applyH(H, wall.x0, floorY)];
  const others = otherQuads ?? (wall.surfaces ?? []).map((s) => s.quad as Pt[]);
  return {
    seedQuad: wall.quad,
    exclude: [...zonePolys(zones, H), ...others],
    clip,
    tolerance: paint.tolerance,
    ...strokesAndTaps(paint, srcW, srcH),
  };
}

/** Mask options for a drawn surface: detection seeded and bounded by its four points. */
function surfaceMaskOptions(wall: Wall, zones: Zone[], s: Surface, srcW: number, srcH: number): MaskOptions {
  const paint = s.paint ?? DEFAULT_PAINT;
  const H = wallToSource(wall);
  const exclusions = (wall.surfaces ?? []).filter((o) => o.kind === 'exclude' && o.id !== s.id).map((o) => o.quad as Pt[]);
  return {
    seedQuad: s.quad,
    // A little slack so the detection can reach edges the pins sit just inside of.
    clip: expand(s.quad, 1.04),
    exclude: [...zonePolys(zones, H), ...exclusions],
    tolerance: paint.tolerance,
    ...strokesAndTaps(paint, srcW, srcH),
  };
}

const maskCache = new Map<string, SmallMask>();

function cachedMask(src: Img, opts: MaskOptions, id: string): SmallMask {
  const key = JSON.stringify([id, src.width, opts]);
  let m = maskCache.get(key);
  if (!m) {
    m = detectWallMask(src, opts);
    maskCache.set(key, m);
    if (maskCache.size > 12) maskCache.delete(maskCache.keys().next().value!);
  }
  return m;
}

/** Mask of one paint target ('wall' or a surface id) on the main photo. */
export async function targetMask(wall: Wall, zones: Zone[], target: string): Promise<SmallMask | null> {
  const src = await loadBlobImg(wall.sourceBlobId);
  if (target === 'wall') return cachedMask(src, wallMaskOptions(wall, zones, wall.paint ?? DEFAULT_PAINT, src.width, src.height), wall.sourceBlobId);
  const s = wall.surfaces?.find((x) => x.id === target);
  if (!s || s.kind === 'exclude') return null;
  return cachedMask(src, surfaceMaskOptions(wall, zones, s, src.width, src.height), wall.sourceBlobId);
}

/** Data URL of the highlight overlay, in source-photo pixel space (scaled by mask.scale). */
export function previewUrl(mask: SmallMask): string {
  return maskPreview(mask).toDataURL('image/png');
}

// ---- Rendering --------------------------------------------------------------------------------

async function renderPainted(wall: Wall, zones: Zone[]): Promise<{ paintedSrcBlobId: string; paintedBlobId: string }> {
  const src = await loadBlobImg(wall.sourceBlobId);
  const out = new Uint8ClampedArray(src.data);
  const jobs: { opts: MaskOptions; paint: WallPaint }[] = [];
  if (wall.paint?.hex) jobs.push({ opts: wallMaskOptions(wall, zones, wall.paint, src.width, src.height), paint: wall.paint });
  for (const s of wall.surfaces ?? []) {
    if (s.kind !== 'exclude' && s.paint?.hex) jobs.push({ opts: surfaceMaskOptions(wall, zones, s, src.width, src.height), paint: s.paint });
  }
  for (const j of jobs) {
    const full = upsampleMask(cachedMask(src, j.opts, wall.sourceBlobId), src.width, src.height);
    repaint(src, full, j.paint.hex, j.paint.strength, out);
  }
  const painted: Img = { data: out, width: src.width, height: src.height };
  const paintedSrcBlobId = await storeCanvas(imgToCanvas(painted), 'image/jpeg', 0.9);
  // Straightened version: warp the painted photo exactly like the original straightening.
  const straight = await loadBlobImg(wall.imageBlobId);
  const ppi = straight.width / (wall.x1 - wall.x0);
  const warped = warp(painted, { quad: wall.quad, w: wall.refW, h: wall.refH, x0: wall.x0, y0: wall.y0, x1: wall.x1, y1: wall.y1, pxPerUnit: ppi });
  const paintedBlobId = await storeCanvas(imgToCanvas(warped), 'image/jpeg', 0.9);
  return { paintedSrcBlobId, paintedBlobId };
}

async function paintedUpToDate(wall: Wall, key: string): Promise<boolean> {
  if (wall.paintedKey !== key || !wall.paintedSrcBlobId || !wall.paintedBlobId) return false;
  return !!(await getBlob(wall.paintedSrcBlobId)) && !!(await getBlob(wall.paintedBlobId));
}

const pending = new Set<string>();
let running = false;

/** Make sure a project's painted images match its paint settings (debounce before calling). */
export function requestPaintRender(projectId: string) {
  pending.add(projectId);
  if (!running) void loop();
}

async function loop() {
  running = true;
  setState({ painting: true });
  try {
    while (pending.size) {
      const id = pending.values().next().value!;
      pending.delete(id);
      const p = getProject(id);
      const wall = p?.wall;
      if (!p || !wall) continue;
      const key = paintKeyOf(wall, p.zones);
      if (!hasAnyPaint(wall)) {
        if (wall.paintedSrcBlobId || wall.paintedBlobId) {
          const cur = getProject(id)!;
          await saveProject({ ...cur, wall: { ...cur.wall!, paintedSrcBlobId: undefined, paintedBlobId: undefined, paintedKey: undefined } });
          await deleteBlob(wall.paintedSrcBlobId);
          await deleteBlob(wall.paintedBlobId);
        }
        continue;
      }
      if (await paintedUpToDate(wall, key)) continue;
      let out: Awaited<ReturnType<typeof renderPainted>>;
      try {
        out = await renderPainted(wall, p.zones);
      } catch (e) {
        console.error('paint render failed', e);
        continue;
      }
      const now = getProject(id);
      if (!now?.wall || paintKeyOf(now.wall, now.zones) !== key) {
        // Settings changed while rendering: throw this result away and go again.
        await deleteBlob(out.paintedSrcBlobId);
        await deleteBlob(out.paintedBlobId);
        pending.add(id);
        continue;
      }
      const old = now.wall;
      await saveProject({ ...now, wall: { ...now.wall, ...out, paintedKey: key }, settings: { ...now.settings, showPaint: true } });
      if (old.paintedSrcBlobId !== out.paintedSrcBlobId) await deleteBlob(old.paintedSrcBlobId);
      if (old.paintedBlobId !== out.paintedBlobId) await deleteBlob(old.paintedBlobId);
    }
  } finally {
    running = false;
    setState({ painting: false });
  }
}

// ---- Auto-suggested surfaces --------------------------------------------------------------------

/** Ceiling: everything above the ceiling line across the photo. */
export function suggestCeiling(wall: Wall, srcW: number): Quad {
  const H = wallToSource(wall);
  const floorY = wall.refH + wall.bottomAboveFloor;
  const ceil = ceilingHeightOf(wall);
  const y = ceil ? floorY - ceil : 0;
  const a = applyH(H, wall.x0, y), b = applyH(H, wall.x1, y);
  const lx = Math.max(0, Math.min(a.x, srcW)), rx = Math.max(0, Math.min(b.x, srcW));
  const lerpY = (x: number) => a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x || 1);
  return [{ x: lx, y: 0 }, { x: rx, y: 0 }, { x: rx, y: lerpY(rx) }, { x: lx, y: lerpY(lx) }];
}

/** Baseboard: a strip along the floor line (default 4½" tall). */
export function suggestBaseboard(wall: Wall, height = 4.5): Quad {
  const H = wallToSource(wall);
  const floorY = wall.refH + wall.bottomAboveFloor;
  return [
    applyH(H, wall.x0, floorY - height), applyH(H, wall.x1, floorY - height), applyH(H, wall.x1, floorY), applyH(H, wall.x0, floorY),
  ];
}

/** A small starting rectangle in the middle of the wall. */
export function suggestArea(wall: Wall): Quad {
  const H = wallToSource(wall);
  const cx = wall.refW / 2, cy = wall.refH / 2, w = Math.min(18, wall.refW / 4), h = Math.min(18, wall.refH / 4);
  return [applyH(H, cx - w, cy - h), applyH(H, cx + w, cy - h), applyH(H, cx + w, cy + h), applyH(H, cx - w, cy + h)];
}

// ---- Extra viewpoints ---------------------------------------------------------------------------

/**
 * Repaint an extra room photo with the wall colour. Taps, brush strokes and no-paint zones live
 * on the wall plane, so they map into the other photo through the wall.
 */
export async function paintVantage(wall: Wall, v: Vantage, zones: Zone[], paint: WallPaint): Promise<string> {
  const main = await loadBlobImg(wall.sourceBlobId);
  const src = await loadBlobImg(v.sourceBlobId);
  const toWall = invert3(wallToSource(wall));
  const Hv = v.H as Mat3;
  const mainToV = multiply3(Hv, toWall);
  const mapPx = (p: Pt): Pt => applyH(mainToV, p.x, p.y);
  const map = (p: Pt): Pt => {
    const q = mapPx({ x: p.x * main.width, y: p.y * main.height });
    return { x: q.x / src.width, y: q.y / src.height };
  };
  const mapped: WallPaint = {
    ...paint,
    taps: (paint.taps ?? []).map(map),
    strokes: (paint.strokes ?? []).map((s) => {
      const c = { x: s.pts[0].x * main.width, y: s.pts[0].y * main.height };
      const k = localScale(mainToV, c);
      return { mode: s.mode, r: (s.r * main.width * k) / src.width, pts: s.pts.map(map) };
    }),
  };
  const quad = [applyH(Hv, 0, 0), applyH(Hv, wall.refW, 0), applyH(Hv, wall.refW, wall.refH), applyH(Hv, 0, wall.refH)] as Quad;
  const virtual: Wall = { ...wall, sourceBlobId: v.sourceBlobId, quad };
  // Surfaces on the wall plane (baseboard, trim, areas) map across; the ceiling does not.
  const others = (wall.surfaces ?? []).filter((s) => s.kind !== 'ceiling').map((s) => s.quad.map(mapPx));
  const opts = wallMaskOptions(virtual, zones, mapped, src.width, src.height, others);
  const full = upsampleMask(cachedMask(src, opts, v.sourceBlobId), src.width, src.height);
  const painted = repaint(src, full, paint.hex, paint.strength);
  return storeCanvas(imgToCanvas(painted), 'image/jpeg', 0.9);
}
