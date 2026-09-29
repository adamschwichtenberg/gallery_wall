// The wall editor: place, drag, snap, rotate and swap frames on the straightened wall photo.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { FrameArt } from '../components/FrameArt';
import { Icon } from '../components/Icon';
import { useBlobUrl, useImgSize } from '../components/ui';
import { footprint, snap, suggestFill, unionBox, type Box, type GapMark, type Guide } from '../lib/arrange';
import { deleteBlob, uid } from '../lib/db';
import { paintKeyOf, paintVantage } from '../lib/paintwall';
import { applyH, rectsOverlap, type Mat3 } from '../lib/geometry';
import { cssMatrix, invert3, localScale, multiply3, scaleMat, viewMat, wallToSource, wallToStraight } from '../lib/projection';
import { storeCanvas } from '../lib/pipeline';
import { renderAuto } from '../lib/render';
import { activeLayout, getProject, navigate, openModal, saveProject, useStore } from '../lib/store';
import type { Frame, Layout, OpeningFill, PaintStroke, Picture, PlacedItem, Project, Pt, Zone } from '../lib/types';
import { fmtLen } from '../lib/units';
import { ArrangePanels, type PanelKind } from './ArrangePanels';
import { View3D } from './View3D';

export type Snapshot = Pick<Project, 'layouts' | 'activeLayoutId' | 'zones' | 'settings'>;

export interface ArrangeCtx {
  project: Project;
  layout: Layout;
  frames: Map<string, Frame>;
  pictures: Map<string, Picture>;
  selection: string[];
  setSelection: (ids: string[]) => void;
  selOpening: { itemId: string; openingId: string } | null;
  setSelOpening: (s: { itemId: string; openingId: string } | null) => void;
  commit: (fn: (p: Project) => Project) => void;
  updateLayout: (fn: (l: Layout) => Layout) => void;
  addFrame: (frameId: string, at?: Pt) => void;
  placedCount: (frameId: string) => number;
  wallGeom: WallGeom;
  preview: Preview | null;
  setPreview: (p: Preview | null) => void;
  reposition: boolean;
  setReposition: (v: boolean) => void;
  fit: () => void;
  panel: PanelKind | null;
  setPanel: (p: PanelKind | null) => void;
  units: 'in' | 'cm';
  clientToWall: (cx: number, cy: number) => Pt;
  mode: 'photo' | 'straight' | 'vantage';
  paintTool: PaintTool;
  setPaintTool: (t: PaintTool) => void;
  brushPx: number;
  setBrushPx: (n: number) => void;
  maskOverlay: MaskOverlay | null;
  setMaskOverlay: (m: MaskOverlay | null) => void;
}

export type PaintTool = 'none' | 'brush' | 'erase' | 'wand';
/** A highlight image in source-photo space (mask pixels = source pixels × scale). */
export interface MaskOverlay { url: string; w: number; h: number; scale: number }

export interface Preview { items: { frameId: string; x: number; y: number }[]; replace: boolean }

export interface WallGeom {
  /** Extent of the photo (or a default blank wall), inches. */
  x0: number; y0: number; x1: number; y1: number;
  floorY: number;
  eyeY: number;
  centerX: number;
  /** Area autofill may use. */
  hang: { x0: number; y0: number; x1: number; y1: number };
}

type View = { s: number; tx: number; ty: number };

export function wallGeometry(p: Project): WallGeom {
  const w = p.wall;
  if (!w) {
    const floorY = 96;
    return { x0: 0, y0: 0, x1: 144, y1: 96, floorY, eyeY: floorY - p.settings.eyeLevel, centerX: 72, hang: { x0: 0, y0: 0, x1: 144, y1: 90 } };
  }
  const floorY = w.refH + w.bottomAboveFloor;
  const extentArea = (w.x1 - w.x0) * (w.y1 - w.y0);
  const pinnedIsWall = (w.refW * w.refH) / extentArea > 0.45;
  const hang = pinnedIsWall
    ? { x0: 0, y0: 0, x1: w.refW, y1: Math.min(w.refH, floorY - 6) }
    : { x0: w.x0, y0: w.y0, x1: w.x1, y1: Math.min(w.y1, floorY - 6) };
  return { x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1, floorY, eyeY: floorY - p.settings.eyeLevel, centerX: (hang.x0 + hang.x1) / 2, hang };
}

export function ArrangeScreen({ id }: { id: string }) {
  const exists = useStore((s) => s.projects.some((p) => p.id === id));
  if (!exists) {
    return (
      <div class="screen"><div class="empty">This wall no longer exists. <button class="btn" onClick={() => navigate({ name: 'projects' })}>Back</button></div></div>
    );
  }
  return <ArrangeInner id={id} />;
}

function ArrangeInner({ id }: { id: string }) {
  const project = useStore((s) => s.projects.find((p) => p.id === id))!;
  const framesList = useStore((s) => s.frames);
  const picturesList = useStore((s) => s.pictures);
  const units = useStore((s) => s.prefs.units);
  const frames = useMemo(() => new Map(framesList.map((f) => [f.id, f])), [framesList]);
  const pictures = useMemo(() => new Map(picturesList.map((p) => [p.id, p])), [picturesList]);

  const [view, setView] = useState<View>({ s: 5, tx: 0, ty: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [selection, setSelectionState] = useState<string[]>([]);
  const [selOpening, setSelOpening] = useState<{ itemId: string; openingId: string } | null>(null);
  const [guides, setGuides] = useState<{ guides: Guide[]; gaps: GapMark[] }>({ guides: [], gaps: [] });
  const [dragInfo, setDragInfo] = useState<string | null>(null);
  const [panel, setPanel] = useState<PanelKind | null>('inventory');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reposition, setReposition] = useState(false);
  const [multi, setMulti] = useState(false);
  const [paintTool, setPaintTool] = useState<PaintTool>('none');
  const [brushPx, setBrushPx] = useState(36);
  const [maskOverlay, setMaskOverlay] = useState<MaskOverlay | null>(null);
  const [strokeDraft, setStrokeDraft] = useState<Pt[] | null>(null);
  const [show3d, setShow3d] = useState(false);
  const [, bump] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const hist = useRef<{ past: Snapshot[]; future: Snapshot[] }>({ past: [], future: [] });

  const wall = project.wall;
  const st = project.settings;
  const vantage = project.vantages?.find((v) => v.id === st.vantageId);
  const mode: 'photo' | 'straight' | 'vantage' = !wall ? 'straight' : st.viewMode === 'straight' ? 'straight' : st.viewMode === 'vantage' && vantage ? 'vantage' : 'photo';
  const straightUrl = useBlobUrl(wall?.imageBlobId);
  const paintedUrl = useBlobUrl(wall?.paintedBlobId);
  const srcUrl = useBlobUrl(wall?.sourceBlobId);
  const paintedSrcUrl = useBlobUrl(wall?.paintedSrcBlobId);
  const straightSize = useImgSize(straightUrl);
  const srcSize = useImgSize(srcUrl);
  const vUrl = useBlobUrl(vantage?.sourceBlobId);
  const vSize = useImgSize(vUrl);
  const paintKey = wall?.paint?.hex ? paintKeyOf(wall, project.zones, wall.paint) : '';
  const vPaintedUrl = useBlobUrl(vantage && vantage.paintKey === paintKey ? vantage.paintedBlobId : undefined);

  const layout = activeLayout(project);
  const geom = wallGeometry(project);

  // ---- projection: wall inches → image pixels → screen ---------------------------------
  const baseUrl = !wall ? undefined
    : mode === 'photo' ? (st.showPaint && paintedSrcUrl) || srcUrl
    : mode === 'vantage' ? (st.showPaint && vPaintedUrl) || vUrl
    : (st.showPaint && paintedUrl) || straightUrl;
  const baseSize = !wall ? { w: 144, h: 96 } : mode === 'photo' ? srcSize : mode === 'vantage' ? vSize : straightSize;
  const H: Mat3 | null = !wall ? scaleMat(1) : !baseSize ? null
    : mode === 'photo' ? wallToSource(wall)
    : mode === 'vantage' ? (vantage!.H as Mat3)
    : wallToStraight(wall, baseSize.w);

  // Extra viewpoints get their own painted copy, rendered when first viewed after a paint change.
  const [vPainting, setVPainting] = useState(false);
  useEffect(() => {
    if (mode !== 'vantage' || !vantage || !wall?.paint?.hex || !st.showPaint || vantage.paintKey === paintKey) return;
    let dead = false;
    setVPainting(true);
    (async () => {
      try {
        const blobId = await paintVantage(wall, vantage, project.zones, wall.paint!);
        const p = getProject(id)!;
        const old = p.vantages?.find((v) => v.id === vantage.id)?.paintedBlobId;
        if (dead) { await deleteBlob(blobId); return; }
        await saveProject({ ...p, vantages: (p.vantages ?? []).map((v) => (v.id === vantage.id ? { ...v, paintedBlobId: blobId, paintKey } : v)) }, false);
        await deleteBlob(old);
      } finally {
        if (!dead) setVPainting(false);
      }
    })();
    return () => { dead = true; };
  }, [mode, vantage?.id, paintKey, st.showPaint]);
  const Hsrc: Mat3 | null = wall ? wallToSource(wall) : null;

  // ---- history -------------------------------------------------------------------
  const snapOf = (p: Project): Snapshot => ({ layouts: p.layouts, activeLayoutId: p.activeLayoutId, zones: p.zones, settings: p.settings });
  const commit = (fn: (p: Project) => Project) => {
    const p = getProject(id)!;
    hist.current.past.push(snapOf(p));
    if (hist.current.past.length > 150) hist.current.past.shift();
    hist.current.future = [];
    void saveProject(fn(p), false);
  };
  const live = (fn: (p: Project) => Project) => void saveProject(fn(getProject(id)!), false);
  const undo = () => {
    const s = hist.current.past.pop();
    if (!s) return;
    const p = getProject(id)!;
    hist.current.future.push(snapOf(p));
    void saveProject({ ...p, ...s }, false);
    bump((n) => n + 1);
  };
  const redo = () => {
    const s = hist.current.future.pop();
    if (!s) return;
    const p = getProject(id)!;
    hist.current.past.push(snapOf(p));
    void saveProject({ ...p, ...s }, false);
    bump((n) => n + 1);
  };
  const withLayout = (p: Project, fn: (l: Layout) => Layout): Project => ({
    ...p,
    layouts: p.layouts.map((l) => (l.id === p.activeLayoutId ? { ...fn(l), updatedAt: Date.now() } : l)),
  });
  const updateLayout = (fn: (l: Layout) => Layout) => commit((p) => withLayout(p, fn));

  const setSelection = (ids: string[]) => {
    setSelectionState(ids);
    if (!selOpening || !ids.includes(selOpening.itemId)) setSelOpening(null);
    setReposition(false);
  };

  // ---- view -------------------------------------------------------------------------
  const sidePad = () => {
    const w = host.current?.clientWidth ?? 1000;
    return w > 820 ? { l: panel ? 344 : 20, r: selection.length ? 344 : 20 } : { l: 12, r: 12 };
  };
  const fit = () => {
    const el = host.current;
    if (!el || !H || !baseSize) return;
    const pad = sidePad();
    const W = el.clientWidth - pad.l - pad.r, Hh = el.clientHeight - 170;
    let bx0: number, by0: number, bx1: number, by1: number;
    if (mode !== 'straight') {
      // Show the whole photo as it was taken.
      bx0 = 0; by0 = 0; bx1 = baseSize.w; by1 = baseSize.h;
    } else {
      // Frame the wall area you hang on (plus the floor line), not the whole photo.
      const h = geom.hang;
      const m = Math.max(h.x1 - h.x0, geom.floorY - h.y0) * 0.06;
      const pts = [[h.x0 - m, h.y0 - m], [h.x1 + m, h.y0 - m], [h.x1 + m, geom.floorY + m], [h.x0 - m, geom.floorY + m]].map(([x, y]) => applyH(H, x, y));
      bx0 = Math.min(...pts.map((p) => p.x)); by0 = Math.min(...pts.map((p) => p.y));
      bx1 = Math.max(...pts.map((p) => p.x)); by1 = Math.max(...pts.map((p) => p.y));
    }
    const bw = bx1 - bx0, bh = by1 - by0;
    const s = Math.min(W / bw, Hh / bh);
    setView({ s, tx: pad.l + (W - bw * s) / 2 - bx0 * s, ty: 84 + (Hh - bh * s) / 2 - by0 * s });
  };
  useLayoutEffect(fit, [wall?.imageBlobId, mode, baseSize?.w, baseSize?.h]);
  useEffect(() => {
    let w = window.innerWidth, h = window.innerHeight;
    const onResize = () => {
      // Re-fit on rotation / split view changes, not on tiny changes (e.g. keyboard).
      if (Math.abs(window.innerWidth - w) > 80 || Math.abs(window.innerHeight - h) > 200) fit();
      w = window.innerWidth; h = window.innerHeight;
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });

  const M: Mat3 | null = H ? multiply3(viewMat(view), H) : null;
  const Minv: Mat3 | null = M ? invert3(M) : null;
  const MinvRef = useRef(Minv);
  MinvRef.current = Minv;
  const localToWall = (p: Pt): Pt => (MinvRef.current ? applyH(MinvRef.current, p.x, p.y) : p);
  const toWall = (cx: number, cy: number): Pt => {
    const r = host.current!.getBoundingClientRect();
    return localToWall({ x: cx - r.left, y: cy - r.top });
  };
  /** Screen pixels per inch around a wall point. */
  const pxPerIn = (p: Pt) => (M ? Math.max(0.05, localScale(M, p)) : 1);

  // ---- placement helpers ------------------------------------------------------------
  const boxes = (items: PlacedItem[]) => items.filter((i) => frames.has(i.frameId)).map((i) => footprint(i, frames.get(i.frameId)!));
  const placedCount = (frameId: string) => layout.items.filter((i) => i.frameId === frameId).length;

  const addFrame = (frameId: string, at?: Pt) => {
    const f = frames.get(frameId);
    if (!f) return;
    const existing = boxes(layout.items);
    let c = at;
    if (!c) {
      if (!existing.length) c = { x: geom.centerX, y: geom.eyeY };
      else {
        // Grow the arrangement: let the autofill engine pick the best neighbouring spot.
        const u = unionBox(existing)!;
        const s = suggestFill({
          pool: [{ frameId, w: f.widthIn, h: f.heightIn }], placed: existing, bounds: geom.hang, zones: project.zones,
          gap: st.gap, centerX: u.x + u.w / 2, centerY: u.y + u.h / 2,
        })[0];
        c = s?.items[0] ? { x: s.items[0].x, y: s.items[0].y } : { x: u.x + u.w + st.gap + f.widthIn / 2, y: u.y + u.h / 2 };
      }
    }
    // Spiral outwards from the target until the frame fits without overlapping.
    let pos = c;
    const free = (p: Pt) => !existing.some((b) => rectsOverlap({ x: p.x - f.widthIn / 2, y: p.y - f.heightIn / 2, w: f.widthIn, h: f.heightIn }, b, st.gap - 0.01));
    if (!free(c)) {
      outer: for (let r = 2; r < 120; r += 2) {
        for (let a = 0; a < 16; a++) {
          const p = { x: c.x + Math.cos((a / 16) * Math.PI * 2) * r, y: c.y + Math.sin((a / 16) * Math.PI * 2) * r };
          if (free(p)) { pos = p; break outer; }
        }
      }
    }
    const item: PlacedItem = { id: uid(), frameId, x: round(pos.x), y: round(pos.y), rotation: 0, fills: {} };
    updateLayout((l) => ({ ...l, items: [...l.items, item] }));
    setSelection([item.id]);
  };

  // ---- gestures -----------------------------------------------------------------------
  type Drag =
    | { kind: 'items'; ids: string[]; start: Map<string, Pt>; p0: Pt; moved: boolean; before: Snapshot; tapId: string; additive: boolean; tapOpening?: string }
    | { kind: 'pan'; start: View; p0: Pt; moved: boolean }
    | { kind: 'pinch'; start: View; d0: number; c0: Pt }
    | { kind: 'eye'; start: number; p0: Pt; before: Snapshot }
    | { kind: 'zone'; zoneId: string; mode: 'move' | 'resize'; start: Zone; p0: Pt; before: Snapshot }
    | { kind: 'picture'; itemId: string; openingId: string; start: OpeningFill; p0: Pt; before: Snapshot }
    | { kind: 'stroke'; pts: Pt[] };
  const drag = useRef<Drag | null>(null);
  const pointers = useRef(new Map<number, Pt>());

  const local = (e: PointerEvent): Pt => {
    const r = host.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const startPinchIfTwo = () => {
    if (pointers.current.size !== 2) return false;
    const [a, b] = [...pointers.current.values()];
    // Abort any item drag that began with the first finger.
    if (drag.current?.kind === 'items' && drag.current.moved) hist.current.past.push(drag.current.before);
    drag.current = { kind: 'pinch', start: viewRef.current, d0: Math.hypot(a.x - b.x, a.y - b.y), c0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    setGuides({ guides: [], gaps: [] });
    return true;
  };

  const onCanvasDown = (e: PointerEvent) => {
    pointers.current.set(e.pointerId, local(e));
    host.current!.setPointerCapture(e.pointerId);
    if (startPinchIfTwo()) return;
    if (panel === 'paint' && paintTool !== 'none' && wall) {
      drag.current = { kind: 'stroke', pts: [local(e)] };
      setStrokeDraft([local(e)]);
      return;
    }
    drag.current = { kind: 'pan', start: viewRef.current, p0: local(e), moved: false };
  };

  const onItemDown = (item: PlacedItem, e: PointerEvent) => {
    e.stopPropagation();
    pointers.current.set(e.pointerId, local(e));
    host.current!.setPointerCapture(e.pointerId);
    if (startPinchIfTwo()) return;
    const additive = multi || e.shiftKey || e.metaKey;
    // Reposition mode: drag the picture inside the selected opening.
    if (reposition && selOpening?.itemId === item.id) {
      const fill = item.fills[selOpening.openingId];
      if (fill) {
        drag.current = { kind: 'picture', itemId: item.id, openingId: selOpening.openingId, start: fill, p0: local(e), before: snapOf(getProject(id)!) };
        return;
      }
    }
    const wasSelected = selection.includes(item.id) && selection.length === 1;
    const tapOpening = wasSelected ? ((e.target as HTMLElement).closest('[data-opening]') as HTMLElement | null)?.dataset.opening : undefined;
    let ids = selection;
    if (!selection.includes(item.id)) ids = additive ? [...selection, item.id] : [item.id];
    if (ids !== selection) setSelection(ids);
    const movable = ids.filter((i) => !layout.items.find((x) => x.id === i)?.locked);
    const start = new Map(layout.items.filter((i) => movable.includes(i.id)).map((i) => [i.id, { x: i.x, y: i.y }]));
    drag.current = { kind: 'items', ids: movable, start, p0: local(e), moved: false, before: snapOf(getProject(id)!), tapId: item.id, additive, tapOpening };
  };

  const onMove = (e: PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, local(e));
    const d = drag.current;
    if (!d) return;
    const p = local(e);
    if (d.kind === 'pinch') {
      if (pointers.current.size < 2) return;
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const s = clampS(d.start.s * (dist / d.d0));
      const k = s / d.start.s;
      setView({ s, tx: c.x - (d.c0.x - d.start.tx) * k, ty: c.y - (d.c0.y - d.start.ty) * k });
      return;
    }
    if (d.kind === 'pan') {
      if (Math.hypot(p.x - d.p0.x, p.y - d.p0.y) > 4) d.moved = true;
      if (d.moved) setView({ ...d.start, tx: d.start.tx + p.x - d.p0.x, ty: d.start.ty + p.y - d.p0.y });
      return;
    }
    const w0 = localToWall('p0' in d ? d.p0 : p), w1 = localToWall(p);
    if (d.kind === 'stroke') {
      d.pts.push(p);
      setStrokeDraft([...d.pts]);
      return;
    }
    if (d.kind === 'eye') {
      const dy = w1.y - w0.y;
      const eye = Math.max(20, Math.min(90, Math.round((d.start - dy) * 4) / 4));
      live((pr) => ({ ...pr, settings: { ...pr.settings, eyeLevel: eye } }));
      return;
    }
    if (d.kind === 'zone') {
      const dx = w1.x - w0.x, dy = w1.y - w0.y;
      const z = d.mode === 'move' ? { ...d.start, x: round(d.start.x + dx), y: round(d.start.y + dy) } : { ...d.start, w: Math.max(1, round(d.start.w + dx)), h: Math.max(1, round(d.start.h + dy)) };
      live((pr) => ({ ...pr, zones: pr.zones.map((x) => (x.id === z.id ? z : x)) }));
      return;
    }
    if (d.kind === 'picture') {
      const item = layout.items.find((i) => i.id === d.itemId)!;
      const op = frames.get(item.frameId)!.openings.find((o) => o.id === d.openingId)!;
      const dx = (w1.x - w0.x) / op.w, dy = (w1.y - w0.y) / op.h;
      const fill = { ...d.start, ox: clamp(d.start.ox + dx, -1, 1), oy: clamp(d.start.oy + dy, -1, 1) };
      live((pr) => withLayout(pr, (l) => ({ ...l, items: l.items.map((i) => (i.id === item.id ? { ...i, fills: { ...i.fills, [d.openingId]: fill } } : i)) })));
      return;
    }
    if (d.kind === 'items') {
      if (!d.moved && Math.hypot(p.x - d.p0.x, p.y - d.p0.y) < 5) return;
      d.moved = true;
      if (!d.ids.length) return;
      let dx = w1.x - w0.x, dy = w1.y - w0.y;
      const moving = d.ids.map((iid) => {
        const it = layout.items.find((i) => i.id === iid)!;
        const s0 = d.start.get(iid)!;
        return footprint({ ...it, x: s0.x + dx, y: s0.y + dy }, frames.get(it.frameId)!);
      });
      const u = unionBox(moving)!;
      let g = { guides: [] as Guide[], gaps: [] as GapMark[] };
      let sy = 0;
      if (st.snap && !e.altKey) {
        const others = boxes(layout.items.filter((i) => !d.ids.includes(i.id)));
        const r = snap(u, others, { gap: st.gap, tol: 10 / pxPerIn({ x: u.x + u.w / 2, y: u.y + u.h / 2 }), xLines: [geom.centerX], yLines: st.showEyeLevel ? [geom.eyeY] : [] });
        dx += r.dx;
        dy += r.dy;
        sy = r.dy;
        g = { guides: r.guides, gaps: r.gaps };
      }
      setGuides(g);
      setDragInfo(`Center ${fmtLen(geom.floorY - (u.y + u.h / 2 + sy), units)} from floor`);
      live((pr) =>
        withLayout(pr, (l) => ({
          ...l,
          items: l.items.map((i) => {
            const s0 = d.start.get(i.id);
            return s0 ? { ...i, x: round(s0.x + dx), y: round(s0.y + dy) } : i;
          }),
        })),
      );
    }
  };

  const onUp = (e: PointerEvent) => {
    pointers.current.delete(e.pointerId);
    const d = drag.current;
    if (pointers.current.size > 0) {
      if (d?.kind === 'pinch') {
        const [p] = [...pointers.current.values()];
        drag.current = { kind: 'pan', start: viewRef.current, p0: p, moved: true };
      }
      return;
    }
    drag.current = null;
    setGuides({ guides: [], gaps: [] });
    setDragInfo(null);
    if (!d) return;
    if (d.kind === 'stroke') {
      finishStroke(d.pts);
      setStrokeDraft(null);
      return;
    }
    if (d.kind === 'pan' && !d.moved) {
      if (!multi) setSelection([]);
      setSelOpening(null);
    }
    if (d.kind === 'items') {
      if (d.moved) {
        hist.current.past.push(d.before);
        hist.current.future = [];
      } else if (d.additive && selection.includes(d.tapId)) {
        setSelection(selection.filter((x) => x !== d.tapId));
      } else if (!d.additive) {
        if (d.tapOpening) {
          const same = selOpening?.itemId === d.tapId && selOpening.openingId === d.tapOpening;
          setSelOpening(same ? null : { itemId: d.tapId, openingId: d.tapOpening });
        } else setSelection([d.tapId]);
      }
    }
    if (d.kind === 'eye' || d.kind === 'zone' || d.kind === 'picture') {
      hist.current.past.push(d.before);
      hist.current.future = [];
    }
    bump((n) => n + 1);
  };

  /** Convert a finger stroke to photo coordinates and store it as a paint touch-up. */
  const finishStroke = (pts: Pt[]) => {
    if (!wall || !Hsrc || !srcSize || !M) return;
    const toSrc = (p: Pt) => { const wp = localToWall(p); return applyH(Hsrc, wp.x, wp.y); };
    const srcPts = pts.map(toSrc);
    const cur = getProject(id)!;
    const paint = cur.wall!.paint ?? { hex: '', name: '', strength: 1, tolerance: 0.6 };
    let next = paint;
    if (paintTool === 'wand' || pts.length < 3) {
      if (paintTool !== 'wand') return;
      const q = srcPts[srcPts.length - 1];
      next = { ...paint, taps: [...(paint.taps ?? []), { x: q.x / srcSize.w, y: q.y / srcSize.h }] };
    } else {
      // Brush radius: screen pixels → photo pixels at the stroke's start.
      const srcToScreen = multiply3(M, invert3(Hsrc));
      const k = Math.max(0.01, localScale(srcToScreen, srcPts[0]));
      const stroke: PaintStroke = {
        mode: paintTool === 'erase' ? 'erase' : 'add',
        r: brushPx / 2 / k / srcSize.w,
        pts: srcPts.filter((_, i) => i % 2 === 0 || i === srcPts.length - 1).map((q) => ({ x: q.x / srcSize.w, y: q.y / srcSize.h })),
      };
      next = { ...paint, strokes: [...(paint.strokes ?? []), stroke] };
    }
    void saveProject({ ...cur, wall: { ...cur.wall!, paint: next } }, false);
  };

  const clampS = (s: number) => {
    const el = host.current;
    const bw = baseSize?.w ?? 144, bh = baseSize?.h ?? 96;
    const base = el ? Math.min(el.clientWidth / bw, el.clientHeight / bh) : 1;
    return Math.max(base * 0.25, Math.min(base * 16, s));
  };

  useEffect(() => {
    const el = host.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const p = { x: e.clientX - r.left, y: e.clientY - r.top };
      const v = viewRef.current;
      if (e.ctrlKey || e.metaKey) {
        const s = clampS(v.s * Math.exp(-e.deltaY * 0.01));
        const k = s / v.s;
        setView({ s, tx: p.x - (p.x - v.tx) * k, ty: p.y - (p.y - v.ty) * k });
      } else setView({ ...v, tx: v.tx - e.deltaX, ty: v.ty - e.deltaY });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  });

  // ---- keyboard (iPad Magic Keyboard / desktop) -----------------------------------------------
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, select')) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); setSelection(layout.items.map((i) => i.id)); return; }
      if (e.key === 'Escape') { setSelection([]); setPreview(null); return; }
      if (!selection.length) return;
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        updateLayout((l) => ({ ...l, items: l.items.filter((i) => !selection.includes(i.id)) }));
        setSelection([]);
        return;
      }
      const step = e.shiftKey ? 1 : 0.25;
      const arrows: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (arrows[e.key]) {
        e.preventDefault();
        const [dx, dy] = arrows[e.key];
        updateLayout((l) => ({ ...l, items: l.items.map((i) => (selection.includes(i.id) && !i.locked ? { ...i, x: round(i.x + dx), y: round(i.y + dy) } : i)) }));
      }
      if (e.key === 'r' || e.key === 'R') {
        updateLayout((l) => ({ ...l, items: l.items.map((i) => (selection.includes(i.id) ? { ...i, rotation: (i.rotation + (e.shiftKey ? -90 : 90) + 360) % 360 } : i)) }));
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  // ---- leaving: save a thumbnail --------------------------------------------------------
  const leave = async () => {
    navigate({ name: 'projects' });
    try {
      const p = getProject(id);
      if (!p?.wall) return;
      const c = await renderAuto(p, activeLayout(p), frames, pictures, { area: 'wall', maxSide: 640, paint: true });
      const thumb = await storeCanvas(c, 'image/jpeg', 0.8);
      const old = p.thumbBlobId;
      await saveProject({ ...getProject(id)!, thumbBlobId: thumb });
      await deleteBlob(old);
    } catch {
      /* thumbnails are best-effort */
    }
  };

  // ---- render --------------------------------------------------------------------------------
  const allBoxes = boxes(layout.items);
  const warn = new Set<string>();
  for (let i = 0; i < allBoxes.length; i++) {
    for (let j = i + 1; j < allBoxes.length; j++) if (rectsOverlap(allBoxes[i], allBoxes[j], -0.01)) { warn.add(allBoxes[i].id); warn.add(allBoxes[j].id); }
    if (project.zones.some((z) => z.noHang && rectsOverlap(allBoxes[i], z, -0.01))) warn.add(allBoxes[i].id);
  }
  const union = unionBox(allBoxes);

  const ctx: ArrangeCtx = {
    project, layout, frames, pictures, selection, setSelection, selOpening, setSelOpening, commit, updateLayout, addFrame, placedCount,
    wallGeom: geom, preview, setPreview, reposition, setReposition, fit, panel, setPanel, units, clientToWall: toWall,
    mode, paintTool, setPaintTool, brushPx, setBrushPx, maskOverlay, setMaskOverlay,
  };

  const P = (x: number, y: number): Pt => (M ? applyH(M, x, y) : { x, y });
  const pts = (list: [number, number][]) => list.map(([x, y]) => { const q = P(x, y); return `${q.x},${q.y}`; }).join(' ');
  // The frames live in a layer laid out at K px per inch, then projected onto the wall.
  const anchor = union ? { x: union.x + union.w / 2, y: union.y + union.h / 2 } : { x: geom.centerX, y: geom.eyeY };
  const K = Math.max(0.5, pxPerIn(anchor));
  const worldTransform = M ? cssMatrix(multiply3(M, scaleMat(1 / K))) : 'none';
  const maskTransform = M && Hsrc && maskOverlay ? cssMatrix(multiply3(multiply3(M, invert3(Hsrc)), scaleMat(1 / maskOverlay.scale))) : 'none';
  const painting = panel === 'paint' && paintTool !== 'none';
  const eyeAt = P(Math.max(geom.x0, geom.hang.x0), geom.eyeY);

  const renderItem = (it: { id?: string; frameId: string; x: number; y: number; rotation?: number; fills?: PlacedItem['fills'] }, ghost: boolean, key: string) => {
    const f = frames.get(it.frameId);
    if (!f) return null;
    const sel = !ghost && !!it.id && selection.includes(it.id);
    const full = it as PlacedItem;
    return (
      <div
        key={key}
        data-id={ghost ? undefined : it.id}
        data-testid={ghost ? undefined : 'placed-item'}
        class={`item ${sel ? 'selected' : ''} ${ghost ? 'ghost' : ''} ${!ghost && warn.has(it.id!) ? 'warn' : ''}`}
        style={{ left: (it.x - f.widthIn / 2) * K, top: (it.y - f.heightIn / 2) * K, width: f.widthIn * K, height: f.heightIn * K, transform: `rotate(${it.rotation ?? 0}deg)`, zIndex: ghost ? 4 : sel ? 3 : 2 }}
        onPointerDown={ghost ? undefined : (e) => onItemDown(full, e as unknown as PointerEvent)}
      >
        <FrameArt
          frame={f} s={K} fills={it.fills} pictures={pictures}
          selectedOpening={!ghost && selOpening && selOpening.itemId === it.id ? selOpening.openingId : null}
          showOpenings={sel && selection.length === 1}
        />
        {(sel || ghost) && <div class="sel-ring" />}
      </div>
    );
  };

  return (
    <div class="arrange">
      <div
        ref={host}
        class={`canvas ${painting ? 'painting' : ''}`}
        data-testid="canvas"
        onPointerDown={onCanvasDown as any}
        onPointerMove={onMove as any}
        onPointerUp={onUp as any}
        onPointerCancel={onUp as any}
      >
        {wall && baseUrl && baseSize ? (
          <img class="wall-img" src={baseUrl} draggable={false} style={{ left: view.tx, top: view.ty, width: baseSize.w * view.s, height: baseSize.h * view.s }} />
        ) : !wall ? (
          <div class="wall-img" style={{ left: view.tx, top: view.ty, width: 144 * view.s, height: 96 * view.s, background: 'linear-gradient(#e9e6df, #d9d5cc)', borderBottom: `${6 * view.s}px solid #f4f2ee` }} />
        ) : (
          <div class="busy"><div class="spinner" /></div>
        )}

        {panel === 'paint' && maskOverlay && (
          <img class="mask-overlay" src={maskOverlay.url} draggable={false} style={{ width: maskOverlay.w, height: maskOverlay.h, transform: maskTransform }} />
        )}

        <svg class="overlay-svg" style={{ zIndex: 1 }}>
          {st.showZones && panel !== 'zones' && project.zones.map((z) => {
            const lp = P(z.x, z.y);
            return (
              <g key={z.id}>
                <polygon class={`zone-rect ${!z.noHang ? 'nopaint-only' : ''}`} points={pts([[z.x, z.y], [z.x + z.w, z.y], [z.x + z.w, z.y + z.h], [z.x, z.y + z.h]])} />
                <text class="svg-label" x={lp.x + 5} y={lp.y + 14}>{z.label}</text>
              </g>
            );
          })}
          {st.showEyeLevel && (() => {
            const a = P(geom.x0, geom.eyeY), b = P(geom.x1, geom.eyeY);
            return <line class="eye-line" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
          })()}
          {!wall && (() => {
            const t = P(geom.centerX, 20);
            return <text class="svg-label" x={t.x} y={t.y} text-anchor="middle" style={{ fontSize: 15 }}>Sample 12′ × 8′ wall — add your wall photo from the Wall menu</text>;
          })()}
        </svg>

        {M && (
          <div class="world" style={{ transform: worldTransform, pointerEvents: painting ? 'none' : undefined }}>
            {!(preview?.replace) && layout.items.map((it) => renderItem(it, false, it.id))}
            {preview && preview.items.map((pi, k) => renderItem(pi, true, `g${k}`))}
          </div>
        )}

        <svg class="overlay-svg" style={{ zIndex: 5 }}>
          {guides.guides.map((g, k) => {
            const a = g.axis === 'x' ? P(g.at, g.from - 4) : P(g.from - 4, g.at);
            const b = g.axis === 'x' ? P(g.at, g.to + 4) : P(g.to + 4, g.at);
            return <line key={k} class="guide-line" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
          })}
          {guides.gaps.map((g, k) => {
            const a = g.axis === 'x' ? P(g.a, g.at) : P(g.at, g.a);
            const b = g.axis === 'x' ? P(g.b, g.at) : P(g.at, g.b);
            return (
              <g key={`gap${k}`}>
                <line class="gap-mark" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
                <text class="svg-label" x={(a.x + b.x) / 2 + (g.axis === 'y' ? 8 : 0)} y={(a.y + b.y) / 2 - (g.axis === 'x' ? 8 : -4)} text-anchor={g.axis === 'x' ? 'middle' : 'start'}>{fmtLen(g.b - g.a, units)}</text>
              </g>
            );
          })}
          {dragInfo && union && (() => {
            const t = P(union.x + union.w / 2, union.y);
            return <text class="svg-label" x={t.x} y={t.y - 12} text-anchor="middle" style={{ fontSize: 13 }}>{dragInfo}</text>;
          })()}
          {!dragInfo && selection.length === 1 && (() => {
            const it = layout.items.find((i) => i.id === selection[0]);
            const f = it && frames.get(it.frameId);
            if (!it || !f) return null;
            const b = footprint(it, f);
            const t = P(it.x, b.y + b.h);
            return <text class="svg-label" x={t.x} y={t.y + 22} text-anchor="middle" style={{ fontSize: 13 }}>{fmtLen(f.widthIn, units, false)} × {fmtLen(f.heightIn, units)}{it.locked ? ' · locked' : ''}</text>;
          })()}
          {strokeDraft && strokeDraft.length > 1 && (
            <polyline points={strokeDraft.map((q) => `${q.x},${q.y}`).join(' ')} fill="none" stroke={paintTool === 'erase' ? 'rgba(255,107,107,0.7)' : 'rgba(143,184,255,0.7)'} stroke-width={brushPx} stroke-linecap="round" stroke-linejoin="round" />
          )}
        </svg>

        {panel === 'zones' && (
          <svg class="overlay-svg" style={{ zIndex: 6 }}>
            {project.zones.map((z) => {
              const lp = P(z.x, z.y), br = P(z.x + z.w, z.y + z.h);
              const start = (mode2: 'move' | 'resize') => (e: PointerEvent) => {
                e.stopPropagation();
                pointers.current.set(e.pointerId, local(e));
                host.current!.setPointerCapture(e.pointerId);
                drag.current = { kind: 'zone', zoneId: z.id, mode: mode2, start: z, p0: local(e), before: snapOf(project) };
              };
              return (
                <g key={z.id}>
                  <polygon class={`zone-rect ${!z.noHang ? 'nopaint-only' : ''}`} style={{ pointerEvents: 'all', cursor: 'move' }} points={pts([[z.x, z.y], [z.x + z.w, z.y], [z.x + z.w, z.y + z.h], [z.x, z.y + z.h]])} onPointerDown={start('move') as any} />
                  <text class="svg-label" x={lp.x + 5} y={lp.y + 14}>{z.label}</text>
                  <circle cx={br.x} cy={br.y} r={12} fill="white" stroke="var(--danger)" stroke-width={2} style={{ pointerEvents: 'all', cursor: 'nwse-resize' }} onPointerDown={start('resize') as any} />
                </g>
              );
            })}
          </svg>
        )}

        {st.showEyeLevel && M && (
          <div
            class="eye-handle"
            style={{ left: Math.max(8, eyeAt.x + 8), top: eyeAt.y }}
            onPointerDown={(e) => {
              e.stopPropagation();
              pointers.current.set(e.pointerId, local(e as unknown as PointerEvent));
              host.current!.setPointerCapture(e.pointerId);
              drag.current = { kind: 'eye', start: st.eyeLevel, p0: local(e as unknown as PointerEvent), before: snapOf(project) };
            }}
          >
            Eye level {fmtLen(st.eyeLevel, units)}
          </div>
        )}
      </div>

      {/* Top HUD */}
      <div class="hud-top">
        <div class="toolbar glass">
          <button class="btn icon-only ghost" onClick={leave} aria-label="Back to walls"><Icon name="back" /></button>
          <div style={{ padding: '0 6px' }}>
            <div style={{ fontWeight: 650, fontSize: 15, lineHeight: 1.1 }}>{project.name}</div>
            <button class="btn ghost small" style={{ padding: 0, minHeight: 20, color: 'var(--text-2)' }} onClick={() => setPanel(panel === 'layouts' ? null : 'layouts')} data-testid="layouts-btn">
              {layout.name} ▾
            </button>
          </div>
        </div>
        <div class="toolbar glass">
          <button class="btn icon-only ghost" onClick={undo} disabled={!hist.current.past.length} aria-label="Undo" data-testid="undo"><Icon name="undo" /></button>
          <button class="btn icon-only ghost" onClick={redo} disabled={!hist.current.future.length} aria-label="Redo" data-testid="redo"><Icon name="redo" /></button>
          <div class="sep" />
          {wall && (
            <div class="segmented view-switch" style={{ background: 'transparent', boxShadow: 'none' }}>
              <button class={mode === 'photo' ? 'on' : ''} data-testid="mode-photo" onClick={() => commit((p) => ({ ...p, settings: { ...p.settings, viewMode: 'photo' } }))}>Photo</button>
              {(project.vantages ?? []).map((v) => (
                <button key={v.id} class={mode === 'vantage' && vantage?.id === v.id ? 'on' : ''} data-testid="mode-vantage" onClick={() => {
                  if (mode === 'vantage' && vantage?.id === v.id) openModal({ kind: 'vantage', projectId: project.id, id: v.id });
                  else commit((p) => ({ ...p, settings: { ...p.settings, viewMode: 'vantage', vantageId: v.id } }));
                }}>{v.name}</button>
              ))}
              <button class={mode === 'straight' ? 'on' : ''} data-testid="mode-straight" onClick={() => commit((p) => ({ ...p, settings: { ...p.settings, viewMode: 'straight' } }))}>Straight-on</button>
              <button data-testid="add-vantage" title="Add a photo from another spot in the room" onClick={() => openModal({ kind: 'vantage', projectId: project.id })}><Icon name="plus" size={16} /> View</button>
            </div>
          )}
          {vPainting && <div class="spinner" style={{ width: 18, height: 18, borderWidth: 2 }} title="Painting this view…" />}
          <div class="sep" />
          <button class={`btn icon-only ghost ${multi ? 'on' : ''}`} onClick={() => setMulti(!multi)} aria-label="Multi-select" title="Select several"><Icon name="select" /></button>
          <button class="btn icon-only ghost" onClick={fit} aria-label="Fit to screen"><Icon name="fit" /></button>
        </div>
      </div>

      {/* Bottom toolbar */}
      <div class="hud-bottom toolbar glass">
        {([
          ['inventory', 'layers', 'Inventory'],
          ['autofill', 'sparkles', 'Autofill'],
          ['paint', 'paint', 'Paint'],
          ['zones', 'zone', 'Zones'],
          ['wall', 'wall', 'Wall'],
        ] as [PanelKind, string, string][]).map(([k, icon, label]) => (
          <button key={k} class={`btn ghost ${panel === k ? 'on' : ''}`} data-testid={`tool-${k}`} onClick={() => setPanel(panel === k ? null : k)}>
            <Icon name={icon} /> <span class="lbl-sm">{label}</span>
          </button>
        ))}
        <button class="btn ghost" data-testid="tool-3d" onClick={() => setShow3d(true)}><Icon name="cube" /> <span class="lbl-sm">3D</span></button>
        <div class="sep" />
        <button class={`btn icon-only ghost ${st.snap ? 'on' : ''}`} aria-label="Snapping" title="Snapping" onClick={() => commit((p) => ({ ...p, settings: { ...p.settings, snap: !p.settings.snap } }))}><Icon name="magnet" /></button>
        <button class={`btn icon-only ghost ${st.showEyeLevel ? 'on' : ''}`} aria-label="Eye level line" title="Eye level line" onClick={() => commit((p) => ({ ...p, settings: { ...p.settings, showEyeLevel: !p.settings.showEyeLevel } }))}><Icon name="eye" /></button>
        <button class={`btn ghost ${panel === 'export' ? 'on' : ''}`} onClick={() => setPanel(panel === 'export' ? null : 'export')} data-testid="tool-export"><Icon name="share" /> <span class="lbl-sm">Export</span></button>
      </div>

      <ArrangePanels ctx={ctx} />
      {show3d && <View3D project={project} layout={layout} frames={frames} pictures={pictures} onClose={() => setShow3d(false)} />}

      {!project.wall && panel !== 'wall' && (
        <div style={{ position: 'absolute', top: 'calc(var(--safe-t) + 80px)', left: '50%', transform: 'translateX(-50%)', zIndex: 16 }}>
          <button class="btn primary" onClick={() => openModal({ kind: 'wall', projectId: project.id })}><Icon name="camera" /> Add your wall photo</button>
        </div>
      )}
    </div>
  );
}

function round(v: number) {
  return Math.round(v * 16) / 16;
}
function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

export type { Box };
