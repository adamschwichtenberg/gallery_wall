// The wall editor: place, drag, snap, rotate and swap frames on the straightened wall photo.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { FrameArt } from '../components/FrameArt';
import { Icon } from '../components/Icon';
import { useBlobUrl } from '../components/ui';
import { footprint, snap, suggestFill, unionBox, type Box, type GapMark, type Guide } from '../lib/arrange';
import { deleteBlob, uid } from '../lib/db';
import { rectsOverlap } from '../lib/geometry';
import { storeCanvas } from '../lib/pipeline';
import { renderLayout } from '../lib/render';
import { activeLayout, getProject, navigate, openModal, saveProject, useStore } from '../lib/store';
import type { Frame, Layout, OpeningFill, Picture, PlacedItem, Project, Pt, Zone } from '../lib/types';
import { fmtLen } from '../lib/units';
import { ArrangePanels, type PanelKind } from './ArrangePanels';

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
}

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
  const [, bump] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const hist = useRef<{ past: Snapshot[]; future: Snapshot[] }>({ past: [], future: [] });

  const wallUrl = useBlobUrl(project?.wall?.imageBlobId);
  const paintedUrl = useBlobUrl(project?.wall?.paintedBlobId);

  const layout = activeLayout(project);
  const geom = wallGeometry(project);
  const st = project.settings;

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
    if (!el) return;
    const pad = sidePad();
    const W = el.clientWidth - pad.l - pad.r, H = el.clientHeight - 170;
    // Frame the wall area you hang on (plus the floor line), not the whole photo.
    const h = geom.hang;
    const m = Math.max(h.x1 - h.x0, geom.floorY - h.y0) * 0.06;
    const fx0 = h.x0 - m, fy0 = h.y0 - m, fx1 = h.x1 + m, fy1 = geom.floorY + m;
    const bw = fx1 - fx0, bh = fy1 - fy0;
    const s = Math.min(W / bw, H / bh);
    setView({ s, tx: pad.l + (W - bw * s) / 2 - fx0 * s, ty: 84 + (H - bh * s) / 2 - fy0 * s });
  };
  useLayoutEffect(fit, [project.wall?.imageBlobId]);
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

  const toWall = (cx: number, cy: number): Pt => {
    const r = host.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (cx - r.left - v.tx) / v.s, y: (cy - r.top - v.ty) / v.s };
  };

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
    | { kind: 'picture'; itemId: string; openingId: string; start: OpeningFill; p0: Pt; before: Snapshot };
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
    const v = viewRef.current;
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
    if (d.kind === 'eye') {
      const dy = (p.y - d.p0.y) / v.s;
      const eye = Math.max(20, Math.min(90, Math.round((d.start - dy) * 4) / 4));
      live((pr) => ({ ...pr, settings: { ...pr.settings, eyeLevel: eye } }));
      return;
    }
    if (d.kind === 'zone') {
      const dx = (p.x - d.p0.x) / v.s, dy = (p.y - d.p0.y) / v.s;
      const z = d.mode === 'move' ? { ...d.start, x: round(d.start.x + dx), y: round(d.start.y + dy) } : { ...d.start, w: Math.max(1, round(d.start.w + dx)), h: Math.max(1, round(d.start.h + dy)) };
      live((pr) => ({ ...pr, zones: pr.zones.map((x) => (x.id === z.id ? z : x)) }));
      return;
    }
    if (d.kind === 'picture') {
      const item = layout.items.find((i) => i.id === d.itemId)!;
      const op = frames.get(item.frameId)!.openings.find((o) => o.id === d.openingId)!;
      const dx = (p.x - d.p0.x) / v.s / op.w, dy = (p.y - d.p0.y) / v.s / op.h;
      const fill = { ...d.start, ox: clamp(d.start.ox + dx, -1, 1), oy: clamp(d.start.oy + dy, -1, 1) };
      live((pr) => withLayout(pr, (l) => ({ ...l, items: l.items.map((i) => (i.id === item.id ? { ...i, fills: { ...i.fills, [d.openingId]: fill } } : i)) })));
      return;
    }
    if (d.kind === 'items') {
      if (!d.moved && Math.hypot(p.x - d.p0.x, p.y - d.p0.y) < 5) return;
      d.moved = true;
      if (!d.ids.length) return;
      let dx = (p.x - d.p0.x) / v.s, dy = (p.y - d.p0.y) / v.s;
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
        const r = snap(u, others, { gap: st.gap, tol: 10 / v.s, xLines: [geom.centerX], yLines: st.showEyeLevel ? [geom.eyeY] : [] });
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

  const clampS = (s: number) => {
    const el = host.current;
    const base = el ? Math.min(el.clientWidth / (geom.x1 - geom.x0), el.clientHeight / (geom.y1 - geom.y0)) : 5;
    return Math.max(base * 0.25, Math.min(base * 12, s));
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
      const c = await renderLayout(p, activeLayout(p), frames, pictures, { area: 'wall', maxSide: 640, paint: true });
      const thumb = await storeCanvas(c, 'image/jpeg', 0.8);
      const old = p.thumbBlobId;
      await saveProject({ ...getProject(id)!, thumbBlobId: thumb });
      await deleteBlob(old);
    } catch {
      /* thumbnails are best-effort */
    }
  };

  // ---- render --------------------------------------------------------------------------------
  const v = view;
  const X = (x: number) => x * v.s + v.tx;
  const Y = (y: number) => y * v.s + v.ty;
  const allBoxes = boxes(layout.items);
  const warn = new Set<string>();
  for (let i = 0; i < allBoxes.length; i++) {
    for (let j = i + 1; j < allBoxes.length; j++) if (rectsOverlap(allBoxes[i], allBoxes[j], -0.01)) { warn.add(allBoxes[i].id); warn.add(allBoxes[j].id); }
    if (project.zones.some((z) => z.noHang && rectsOverlap(allBoxes[i], z, -0.01))) warn.add(allBoxes[i].id);
  }
  const wallImg = st.showPaint && paintedUrl ? paintedUrl : wallUrl;
  const union = unionBox(allBoxes);

  const ctx: ArrangeCtx = {
    project, layout, frames, pictures, selection, setSelection, selOpening, setSelOpening, commit, updateLayout, addFrame, placedCount,
    wallGeom: geom, preview, setPreview, reposition, setReposition, fit, panel, setPanel, units, clientToWall: toWall,
  };

  return (
    <div class="arrange">
      <div
        ref={host}
        class="canvas"
        data-testid="canvas"
        onPointerDown={onCanvasDown as any}
        onPointerMove={onMove as any}
        onPointerUp={onUp as any}
        onPointerCancel={onUp as any}
      >
        {project.wall && wallImg ? (
          <img class="wall-img" src={wallImg} draggable={false} style={{ left: X(geom.x0), top: Y(geom.y0), width: (geom.x1 - geom.x0) * v.s, height: (geom.y1 - geom.y0) * v.s }} />
        ) : (
          <div class="wall-img" style={{ left: X(geom.x0), top: Y(geom.y0), width: (geom.x1 - geom.x0) * v.s, height: (geom.y1 - geom.y0) * v.s, background: 'linear-gradient(#e9e6df, #d9d5cc)', borderBottom: `${8 * v.s}px solid #f4f2ee` }} />
        )}

        <svg class="overlay-svg" style={{ zIndex: 1 }}>
          {st.showZones && panel !== 'zones' && project.zones.map((z) => (
            <g key={z.id}>
              <rect class={`zone-rect ${!z.noHang ? 'nopaint-only' : ''}`} x={X(z.x)} y={Y(z.y)} width={z.w * v.s} height={z.h * v.s} rx={3} />
              <text class="svg-label" x={X(z.x) + 5} y={Y(z.y) + 14}>{z.label}</text>
            </g>
          ))}
          {st.showEyeLevel && <line class="eye-line" x1={0} x2="100%" y1={Y(geom.eyeY)} y2={Y(geom.eyeY)} />}
          {!project.wall && (
            <text class="svg-label" x={X(geom.centerX)} y={Y(20)} text-anchor="middle" style={{ fontSize: 15 }}>Sample 12′ × 8′ wall — add your wall photo from the Wall menu</text>
          )}
        </svg>

        {!(preview?.replace) && layout.items.map((it) => {
          const f = frames.get(it.frameId);
          if (!f) return null;
          const sel = selection.includes(it.id);
          return (
            <div
              key={it.id}
              data-id={it.id}
              data-testid="placed-item"
              class={`item ${sel ? 'selected' : ''} ${warn.has(it.id) ? 'warn' : ''}`}
              style={{ left: X(it.x - f.widthIn / 2), top: Y(it.y - f.heightIn / 2), width: f.widthIn * v.s, height: f.heightIn * v.s, transform: `rotate(${it.rotation}deg)`, zIndex: sel ? 3 : 2 }}
              onPointerDown={(e) => onItemDown(it, e as unknown as PointerEvent)}
            >
              <FrameArt
                frame={f} s={v.s} fills={it.fills} pictures={pictures}
                selectedOpening={selOpening?.itemId === it.id ? selOpening.openingId : null}
                showOpenings={sel && selection.length === 1}
              />
              {sel && <div class="sel-ring" />}
              {sel && selection.length === 1 && (
                <div class="dim-label" style={{ transform: `translateX(-50%) rotate(${-it.rotation}deg)` }}>
                  {fmtLen(f.widthIn, units, false)} × {fmtLen(f.heightIn, units)}{it.locked ? ' · locked' : ''}
                </div>
              )}
            </div>
          );
        })}

        {preview && preview.items.map((pi, k) => {
          const f = frames.get(pi.frameId);
          if (!f) return null;
          return (
            <div key={`g${k}`} class="item ghost" style={{ left: X(pi.x - f.widthIn / 2), top: Y(pi.y - f.heightIn / 2), width: f.widthIn * v.s, height: f.heightIn * v.s, zIndex: 4 }}>
              <FrameArt frame={f} s={v.s} />
              <div class="sel-ring" />
            </div>
          );
        })}

        <svg class="overlay-svg" style={{ zIndex: 5 }}>
          {guides.guides.map((g, k) =>
            g.axis === 'x' ? (
              <line key={k} class="guide-line" x1={X(g.at)} x2={X(g.at)} y1={Y(g.from) - 20} y2={Y(g.to) + 20} />
            ) : (
              <line key={k} class="guide-line" y1={Y(g.at)} y2={Y(g.at)} x1={X(g.from) - 20} x2={X(g.to) + 20} />
            ),
          )}
          {guides.gaps.map((g, k) =>
            g.axis === 'x' ? (
              <g key={`gap${k}`}>
                <line class="gap-mark" x1={X(g.a)} x2={X(g.b)} y1={Y(g.at)} y2={Y(g.at)} />
                <text class="svg-label" x={(X(g.a) + X(g.b)) / 2} y={Y(g.at) - 6} text-anchor="middle">{fmtLen(g.b - g.a, units)}</text>
              </g>
            ) : (
              <g key={`gap${k}`}>
                <line class="gap-mark" y1={Y(g.a)} y2={Y(g.b)} x1={X(g.at)} x2={X(g.at)} />
                <text class="svg-label" x={X(g.at) + 6} y={(Y(g.a) + Y(g.b)) / 2 + 4}>{fmtLen(g.b - g.a, units)}</text>
              </g>
            ),
          )}
          {dragInfo && union && (
            <text class="svg-label" x={X(union.x + union.w / 2)} y={Y(union.y) - 12} text-anchor="middle" style={{ fontSize: 13 }}>{dragInfo}</text>
          )}
        </svg>

        {st.showEyeLevel && (
          <div
            class="eye-handle"
            style={{ left: X(geom.x0) + 8 > 8 ? X(geom.x0) + 8 : 8, top: Y(geom.eyeY) }}
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

        {panel === 'zones' && project.zones.map((z) => (
          <div
            key={z.id}
            class="zone-box"
            style={{ left: X(z.x), top: Y(z.y), width: z.w * v.s, height: z.h * v.s, zIndex: 6, borderColor: z.noHang ? undefined : 'var(--eye)' }}
            onPointerDown={(e) => {
              e.stopPropagation();
              pointers.current.set(e.pointerId, local(e as unknown as PointerEvent));
              host.current!.setPointerCapture(e.pointerId);
              drag.current = { kind: 'zone', zoneId: z.id, mode: 'move', start: z, p0: local(e as unknown as PointerEvent), before: snapOf(project) };
            }}
          >
            <span class="zone-label">{z.label}</span>
            <div
              class="zone-resize"
              onPointerDown={(e) => {
                e.stopPropagation();
                pointers.current.set(e.pointerId, local(e as unknown as PointerEvent));
                host.current!.setPointerCapture(e.pointerId);
                drag.current = { kind: 'zone', zoneId: z.id, mode: 'resize', start: z, p0: local(e as unknown as PointerEvent), before: snapOf(project) };
              }}
            />
          </div>
        ))}
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
        <div class="sep" />
        <button class={`btn icon-only ghost ${st.snap ? 'on' : ''}`} aria-label="Snapping" title="Snapping" onClick={() => commit((p) => ({ ...p, settings: { ...p.settings, snap: !p.settings.snap } }))}><Icon name="magnet" /></button>
        <button class={`btn icon-only ghost ${st.showEyeLevel ? 'on' : ''}`} aria-label="Eye level line" title="Eye level line" onClick={() => commit((p) => ({ ...p, settings: { ...p.settings, showEyeLevel: !p.settings.showEyeLevel } }))}><Icon name="eye" /></button>
        <button class={`btn ghost ${panel === 'export' ? 'on' : ''}`} onClick={() => setPanel(panel === 'export' ? null : 'export')} data-testid="tool-export"><Icon name="share" /> <span class="lbl-sm">Export</span></button>
      </div>

      <ArrangePanels ctx={ctx} />

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
