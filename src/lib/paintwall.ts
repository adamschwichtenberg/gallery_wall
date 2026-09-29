// Wall-colour pipeline: detect the wall on the original photo, repaint it, and derive the
// straightened version from the painted photo so both views always match.
import { blobUrl, deleteBlob } from './db';
import { applyH, invert3, multiply3, type Mat3 } from './geometry';
import { canvasToImg, imgToCanvas, loadImageElement, makeCanvas, warp, type Img } from './imaging';
import { storeCanvas } from './pipeline';
import { localScale, wallToSource } from './projection';
import { detectWallMask, maskPreview, repaint, upsampleMask, type MaskOptions, type SmallMask } from './recolor';
import type { Pt, Vantage, Wall, WallPaint, Zone } from './types';

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

export function maskOptionsFor(wall: Wall, zones: Zone[], paint: WallPaint, srcW: number, srcH: number): MaskOptions {
  const H = wallToSource(wall);
  const exclude = zones
    .filter((z) => z.noPaint)
    .map((z) => [
      applyH(H, z.x, z.y), applyH(H, z.x + z.w, z.y), applyH(H, z.x + z.w, z.y + z.h), applyH(H, z.x, z.y + z.h),
    ]);
  // The wall plane between floor and ceiling, projected into the photo.
  const floorY = wall.refH + wall.bottomAboveFloor;
  const ceil = ceilingHeightOf(wall);
  const top = ceil ? floorY - ceil : wall.y0;
  const clip = [
    applyH(H, wall.x0, top), applyH(H, wall.x1, top), applyH(H, wall.x1, floorY), applyH(H, wall.x0, floorY),
  ];
  return {
    seedQuad: wall.quad,
    exclude,
    clip,
    tolerance: paint.tolerance,
    taps: (paint.taps ?? []).map((p) => ({ x: p.x * srcW, y: p.y * srcH })),
    strokes: (paint.strokes ?? []).map((s) => ({ mode: s.mode, r: s.r * srcW, pts: s.pts.map((p) => ({ x: p.x * srcW, y: p.y * srcH })) })),
  };
}

/** Known ceiling height, or a safe guess when the pinned area clearly spans floor to ceiling. */
export function ceilingHeightOf(wall: Wall): number | undefined {
  if (wall.ceilingHeight) return wall.ceilingHeight;
  if (wall.bottomAboveFloor <= 1 && wall.refH >= 84) return wall.refH + wall.bottomAboveFloor + 0.5;
  return undefined;
}

let maskCache: { key: string; mask: SmallMask } | null = null;

export async function wallMaskFor(wall: Wall, zones: Zone[], paint: WallPaint): Promise<{ mask: SmallMask; src: Img }> {
  const src = await loadBlobImg(wall.sourceBlobId);
  const opts = maskOptionsFor(wall, zones, paint, src.width, src.height);
  const key = JSON.stringify([wall.sourceBlobId, wall.quad, opts.exclude, opts.clip, opts.tolerance, opts.taps, opts.strokes]);
  if (maskCache?.key === key) return { mask: maskCache.mask, src };
  const mask = detectWallMask(src, opts);
  maskCache = { key, mask };
  return { mask, src };
}

/** Data URL of the highlight overlay, in source-photo pixel space (scaled by mask.scale). */
export function previewUrl(mask: SmallMask): string {
  return maskPreview(mask).toDataURL('image/png');
}

/** Repaint the wall and store both the photo and the straightened versions. */
export async function applyPaint(wall: Wall, zones: Zone[], paint: WallPaint): Promise<Pick<Wall, 'paintedBlobId' | 'paintedSrcBlobId'>> {
  const { mask, src } = await wallMaskFor(wall, zones, paint);
  const full = upsampleMask(mask, src.width, src.height);
  const painted = repaint(src, full, paint.hex, paint.strength);
  const paintedSrcBlobId = await storeCanvas(imgToCanvas(painted), 'image/jpeg', 0.9);

  // Straightened version: warp the painted photo exactly like the original straightening.
  const straight = await loadBlobImg(wall.imageBlobId);
  const ppi = straight.width / (wall.x1 - wall.x0);
  const warped = warp(painted, { quad: wall.quad, w: wall.refW, h: wall.refH, x0: wall.x0, y0: wall.y0, x1: wall.x1, y1: wall.y1, pxPerUnit: ppi });
  const paintedBlobId = await storeCanvas(imgToCanvas(warped), 'image/jpeg', 0.9);

  await deleteBlob(wall.paintedBlobId);
  await deleteBlob(wall.paintedSrcBlobId);
  return { paintedBlobId, paintedSrcBlobId };
}

/** Everything that affects the painted result, for knowing when a cached render is stale. */
export function paintKeyOf(wall: Wall, zones: Zone[], paint: WallPaint): string {
  return JSON.stringify([wall.sourceBlobId, wall.quad, wall.ceilingHeight, paint, zones.filter((z) => z.noPaint)]);
}

/**
 * Repaint an extra room photo. Everything the user did on the main photo (taps, brush strokes,
 * no-paint zones) lives on the wall plane, so it maps into the other photo through the wall.
 */
export async function paintVantage(wall: Wall, v: Vantage, zones: Zone[], paint: WallPaint): Promise<string> {
  const main = await loadBlobImg(wall.sourceBlobId);
  const src = await loadBlobImg(v.sourceBlobId);
  const toWall = invert3(wallToSource(wall));
  const Hv = v.H as Mat3;
  const map = (p: Pt): Pt => {
    const w = applyH(toWall, p.x * main.width, p.y * main.height);
    const q = applyH(Hv, w.x, w.y);
    return { x: q.x / src.width, y: q.y / src.height };
  };
  const mainToV = multiply3(Hv, toWall);
  const mapped: WallPaint = {
    ...paint,
    taps: (paint.taps ?? []).map(map),
    strokes: (paint.strokes ?? []).map((s) => {
      const c = { x: s.pts[0].x * main.width, y: s.pts[0].y * main.height };
      const k = localScale(mainToV, c);
      return { mode: s.mode, r: (s.r * main.width * k) / src.width, pts: s.pts.map(map) };
    }),
  };
  // A "virtual wall" whose pinned rectangle is where the measured area appears in this photo.
  const quad = [
    applyH(Hv, 0, 0), applyH(Hv, wall.refW, 0), applyH(Hv, wall.refW, wall.refH), applyH(Hv, 0, wall.refH),
  ] as Wall['quad'];
  const virtual: Wall = { ...wall, sourceBlobId: v.sourceBlobId, quad };
  const { mask } = await wallMaskFor(virtual, zones, mapped);
  const full = upsampleMask(mask, src.width, src.height);
  const painted = repaint(src, full, paint.hex, paint.strength);
  return storeCanvas(imgToCanvas(painted), 'image/jpeg', 0.9);
}
