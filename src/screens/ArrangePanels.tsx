import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { emptyFrameFilter, emptyPictureFilter, filterFrames, filterPictures, FrameFilterBar, PictureFilterBar, type FrameFilter, type PictureFilter } from '../components/Filters';
import { FrameThumb } from '../components/FrameArt';
import { Icon } from '../components/Icon';
import { LengthInput, Segmented, Toggle, useBlobUrl } from '../components/ui';
import { footprint, rankFrameSwaps, rankPictures, suggestFill, suggestFromScratch, unionBox, type Suggestion } from '../lib/arrange';
import { shareOrDownload } from '../lib/backup';
import { blobUrl, deleteBlob, uid } from '../lib/db';
import { canvasToImg, imgToCanvas, loadImageElement, makeCanvas } from '../lib/imaging';
import { PAINT_FAMILIES, SW_PAINTS } from '../lib/paints';
import { nextFrame, storeCanvas } from '../lib/pipeline';
import { applyPaint, ceilingHeightOf, previewUrl, wallMaskFor } from '../lib/paintwall';
import { renderToBlob } from '../lib/render';
import { getProject, newLayout, openModal, saveProject, toast } from '../lib/store';
import type { Frame, Layout, OpeningFill, PlacedItem, Project, WallPaint, Zone } from '../lib/types';
import { fmtLen, fmtSize } from '../lib/units';
import { FineRotate } from './FrameEditor';
import type { ArrangeCtx, PaintTool } from './Arrange';

export type PanelKind = 'inventory' | 'autofill' | 'paint' | 'zones' | 'wall' | 'layouts' | 'export';

export function ArrangePanels({ ctx }: { ctx: ArrangeCtx }) {
  const p = ctx.panel;
  return (
    <>
      {p && (
        <div class="side-panel left glass strong" data-testid={`panel-${p}`}>
          <div class="panel-head">
            <h2 class="grow">{TITLES[p]}</h2>
            <button class="btn small icon-only ghost" onClick={() => { ctx.setPanel(null); ctx.setPreview(null); }} aria-label="Close panel"><Icon name="close" /></button>
          </div>
          <div class="panel-body">
            {p === 'inventory' && <InventoryPanel ctx={ctx} />}
            {p === 'autofill' && <AutofillPanel ctx={ctx} />}
            {p === 'paint' && <PaintPanel ctx={ctx} />}
            {p === 'zones' && <ZonesPanel ctx={ctx} />}
            {p === 'wall' && <WallPanel ctx={ctx} />}
            {p === 'layouts' && <LayoutsPanel ctx={ctx} />}
            {p === 'export' && <ExportPanel ctx={ctx} />}
          </div>
        </div>
      )}
      {ctx.selection.length > 0 && (
        <div class="side-panel right glass strong" data-testid="inspector">
          <Inspector ctx={ctx} />
        </div>
      )}
    </>
  );
}

const TITLES: Record<PanelKind, string> = {
  inventory: 'Frames', autofill: 'Autofill', paint: 'Wall color', zones: 'Zones', wall: 'Wall & spacing', layouts: 'Layouts', export: 'Export',
};

// ---- Inventory tray ------------------------------------------------------------------------

type DragGhost = { kind: 'frame'; id: string; x: number; y: number } | null;

function InventoryPanel({ ctx }: { ctx: ArrangeCtx }) {
  const [ff, setFf] = useState<FrameFilter>(emptyFrameFilter);
  const [ghost, setGhost] = useState<DragGhost>(null);
  const frames = [...ctx.frames.values()];
  const fl = filterFrames(frames, ff);

  const onDrop = (g: NonNullable<DragGhost>) => {
    const el = document.elementFromPoint(g.x, g.y) as HTMLElement | null;
    if (!el || el.closest('.side-panel') || !el.closest('.canvas')) return;
    ctx.addFrame(g.id, ctx.clientToWall(g.x, g.y));
  };

  return (
    <>
      {frames.length > 0 && <FrameFilterBar frames={frames} value={ff} onChange={setFf} compact />}
      <div class="hint">Tap to add, or drag onto the wall. To change a frame’s picture, tap the frame on the wall.</div>
      <div class="tray-grid">
        {fl.map((f) => {
          const left = f.qty - ctx.placedCount(f.id);
          return (
            <TrayCard
              key={f.id}
              testid="tray-frame"
              out={left <= 0}
              onTap={() => (left > 0 ? ctx.addFrame(f.id) : toast('All copies of this frame are already on the wall'))}
              onDrag={(x, y, phase) => {
                if (left <= 0) return;
                const g = { kind: 'frame' as const, id: f.id, x, y };
                if (phase === 'end') { setGhost(null); onDrop(g); } else setGhost(g);
              }}
            >
              <div class="thumb"><FrameThumb frame={f} box={110} /></div>
              <div class="size">{fmtSize(f.widthIn, f.heightIn, ctx.units)}</div>
              <span class="left">{left <= 0 ? 'placed' : `${left} left`}</span>
            </TrayCard>
          );
        })}
      </div>
      {!frames.length && <div class="hint">No frames yet — add some to your inventory.</div>}
      <button class="btn" onClick={() => openModal({ kind: 'frame' })}><Icon name="plus" /> New frame</button>
      {ghost && (
        <div class="drag-ghost" style={{ left: ghost.x, top: ghost.y }}>
          <FrameThumb frame={ctx.frames.get(ghost.id)!} box={120} />
        </div>
      )}
    </>
  );
}

/** First empty opening of a placed frame (or the first opening). */
function pickOpening(item: PlacedItem, f: Frame): string | undefined {
  return (f.openings.find((o) => !item.fills[o.id]) ?? f.openings[0])?.id;
}

export function assignPicture(ctx: ArrangeCtx, itemId: string, openingId: string, pictureId: string) {
  const fill: OpeningFill = { pictureId, scale: 1, ox: 0, oy: 0, rot: 0 };
  ctx.updateLayout((l) => ({ ...l, items: l.items.map((i) => (i.id === itemId ? { ...i, fills: { ...i.fills, [openingId]: fill } } : i)) }));
  ctx.setSelection([itemId]);
  ctx.setSelOpening({ itemId, openingId });
}

function TrayCard({ children, onTap, onDrag, out, testid }: { children: preact.ComponentChildren; onTap: () => void; onDrag: (x: number, y: number, phase: 'move' | 'end') => void; out?: boolean; testid?: string }) {
  const st = useRef<{ x: number; y: number; dragging: boolean; id: number } | null>(null);
  return (
    <div
      class={`tray-card ${out ? 'out' : ''}`}
      data-testid={testid}
      style={{ touchAction: 'pan-y' }}
      onPointerDown={(e) => {
        st.current = { x: e.clientX, y: e.clientY, dragging: false, id: e.pointerId };
      }}
      onPointerMove={(e) => {
        const s = st.current;
        if (!s || s.id !== e.pointerId) return;
        if (!s.dragging && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 8) {
          s.dragging = true;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }
        if (s.dragging) onDrag(e.clientX, e.clientY, 'move');
      }}
      onPointerUp={(e) => {
        const s = st.current;
        st.current = null;
        if (!s) return;
        if (s.dragging) onDrag(e.clientX, e.clientY, 'end');
        else onTap();
      }}
      onPointerCancel={() => (st.current = null)}
    >
      {children}
    </div>
  );
}

function PictureTrayCard({ blobId, onTap, onDrag }: { id: string; blobId: string; onTap: () => void; onDrag: (x: number, y: number, phase: 'move' | 'end', url?: string) => void }) {
  const url = useBlobUrl(blobId);
  return (
    <TrayCard onTap={onTap} onDrag={(x, y, ph) => onDrag(x, y, ph, url)}>
      <div class="thumb cover">{url && <img src={url} />}</div>
    </TrayCard>
  );
}

// ---- Inspector (selection) -----------------------------------------------------------------

function Inspector({ ctx }: { ctx: ArrangeCtx }) {
  const items = ctx.layout.items.filter((i) => ctx.selection.includes(i.id));
  if (!items.length) return null;
  if (items.length > 1) return <MultiInspector ctx={ctx} items={items} />;
  const it = items[0];
  const f = ctx.frames.get(it.frameId);
  if (!f) return null;
  const g = ctx.wallGeom;
  const upd = (patch: Partial<PlacedItem>) => ctx.updateLayout((l) => ({ ...l, items: l.items.map((i) => (i.id === it.id ? { ...i, ...patch } : i)) }));
  const fp = footprint(it, f);
  const left = ctx.frames.get(it.frameId)!.qty - ctx.placedCount(it.frameId);
  const swaps = rankFrameSwaps(f, [...ctx.frames.values()].filter((x) => x.qty - ctx.placedCount(x.id) > 0)).slice(0, 6);
  const selOp = ctx.selOpening?.itemId === it.id ? f.openings.find((o) => o.id === ctx.selOpening!.openingId) : undefined;

  return (
    <>
      <div class="panel-head">
        <div class="grow">
          <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.02em' }}>{fmtSize(f.widthIn, f.heightIn, ctx.units)}</div>
          <div class="muted small-text">{f.name}</div>
        </div>
        <button class="btn small icon-only ghost" onClick={() => ctx.setSelection([])} aria-label="Deselect"><Icon name="close" /></button>
      </div>
      <div class="panel-body">
        <div class="section-title">Position</div>
        <div class="row">
          <div class="grow"><LengthInput label="Left edge from wall edge" value={fp.x - g.hang.x0 || 0.001} onChange={(v) => upd({ x: v + g.hang.x0 + fp.w / 2 })} /></div>
        </div>
        <div class="row">
          <div class="grow"><LengthInput label="Center height from floor" value={g.floorY - it.y} onChange={(v) => upd({ y: g.floorY - v })} /></div>
        </div>
        <div class="row wrap">
          <button class="btn small" onClick={() => upd({ y: g.eyeY })}>Center on eye level</button>
          <button class="btn small" onClick={() => upd({ x: g.centerX })}>Center on wall</button>
        </div>

        <div class="section-title">Rotate</div>
        <div class="row">
          <button class="btn" onClick={() => upd({ rotation: (Math.round(it.rotation / 90) * 90 + 270) % 360 })}><Icon name="rotL" /> 90°</button>
          <button class="btn" onClick={() => upd({ rotation: (Math.round(it.rotation / 90) * 90 + 90) % 360 })}><Icon name="rotR" /> 90°</button>
        </div>
        <FineRotate value={round1(it.rotation - Math.round(it.rotation / 90) * 90)} onChange={(v) => upd({ rotation: Math.round(it.rotation / 90) * 90 + v })} />

        {f.openings.length > 0 && (
          <>
            <div class="section-title">Pictures in this frame</div>
            <div class="col" style={{ gap: 6 }}>
              {f.openings.map((o, k) => (
                <OpeningRow key={o.id} ctx={ctx} item={it} openingId={o.id} label={`${f.openings.length > 1 ? `Opening ${k + 1} · ` : ''}${fmtSize(o.w, o.h, ctx.units)}`} />
              ))}
            </div>
            {selOp && <PictureChooser ctx={ctx} item={it} frame={f} openingId={selOp.id} />}
          </>
        )}

        {swaps.length > 0 && (
          <>
            <div class="section-title">Swap frame</div>
            <div class="col" style={{ gap: 6 }}>
              {swaps.map(({ frame: s, rotate }) => (
                <button key={s.id} class="list-btn" onClick={() => upd({ frameId: s.id, fills: {}, rotation: rotate ? 90 : 0 })}>
                  <div style={{ width: 44, height: 44, display: 'grid', placeItems: 'center' }}><FrameThumb frame={s} box={42} /></div>
                  <div class="t"><div>{fmtSize(s.widthIn, s.heightIn, ctx.units)}</div><div>{s.name}{rotate ? ' · rotated' : ''}</div></div>
                </button>
              ))}
            </div>
          </>
        )}

        <div class="section-title">Frame</div>
        <div class="row wrap">
          <button class={`btn small ${it.locked ? 'on' : ''}`} onClick={() => upd({ locked: !it.locked })}><Icon name={it.locked ? 'lock' : 'unlock'} size={16} /> {it.locked ? 'Locked' : 'Lock'}</button>
          <button class="btn small" disabled={left <= 0} onClick={() => ctx.addFrame(f.id, { x: it.x + f.widthIn + 2, y: it.y })}><Icon name="duplicate" size={16} /> Another</button>
          <button class="btn small" onClick={() => openModal({ kind: 'frame', id: f.id })}><Icon name="pen" size={16} /> Edit</button>
          <button class="btn small danger" data-testid="remove-item" onClick={() => { ctx.updateLayout((l) => ({ ...l, items: l.items.filter((i) => i.id !== it.id) })); ctx.setSelection([]); }}><Icon name="trash" size={16} /> Remove</button>
        </div>
      </div>
    </>
  );
}

function OpeningRow({ ctx, item, openingId, label }: { ctx: ArrangeCtx; item: PlacedItem; openingId: string; label: string }) {
  const fill = item.fills[openingId];
  const pic = fill ? ctx.pictures.get(fill.pictureId) : undefined;
  const url = useBlobUrl(pic?.imageBlobId);
  const on = ctx.selOpening?.itemId === item.id && ctx.selOpening.openingId === openingId;
  return (
    <button class={`list-btn ${on ? 'on' : ''}`} onClick={() => ctx.setSelOpening(on ? null : { itemId: item.id, openingId })}>
      {url ? <img src={url} /> : <div style={{ width: 44, height: 44, borderRadius: 8, background: 'rgba(255,255,255,0.08)', display: 'grid', placeItems: 'center' }}><Icon name="picture" size={18} /></div>}
      <div class="t"><div>{pic?.name ?? 'Original picture'}</div><div>{label}</div></div>
      <Icon name="swap" size={18} />
    </button>
  );
}

function PictureChooser({ ctx, item, frame, openingId }: { ctx: ArrangeCtx; item: PlacedItem; frame: Frame; openingId: string }) {
  const op = frame.openings.find((o) => o.id === openingId)!;
  const fill = item.fills[openingId];
  const used = new Set(ctx.layout.items.flatMap((i) => Object.values(i.fills).map((f) => f.pictureId)));
  const neighbours = ctx.layout.items.flatMap((i) => Object.values(i.fills).map((f) => ctx.pictures.get(f.pictureId)?.tags.color ?? ''));
  const ranked = rankPictures(op, [...ctx.pictures.values()], used, neighbours).slice(0, 12);
  const setFill = (patch: Partial<OpeningFill>) =>
    ctx.updateLayout((l) => ({ ...l, items: l.items.map((i) => (i.id === item.id ? { ...i, fills: { ...i.fills, [openingId]: { ...i.fills[openingId], ...patch } } } : i)) }));
  return (
    <div class="col glass" style={{ padding: 12, borderRadius: 16, gap: 10 }}>
      {fill && (
        <>
          <b style={{ fontSize: 14 }}>Adjust picture</b>
          <div class="row">
            <span class="small-text muted" style={{ width: 44 }}>Zoom</span>
            <input type="range" min={1} max={3} step={0.02} value={fill.scale} onChange={(e) => setFill({ scale: +(e.target as HTMLInputElement).value })} />
          </div>
          <div class="row wrap">
            <button class="btn small" onClick={() => setFill({ rot: (fill.rot + 90) % 360 })}><Icon name="rotR" size={16} /> 90°</button>
            <button class={`btn small ${ctx.reposition ? 'on' : ''}`} onClick={() => ctx.setReposition(!ctx.reposition)}><Icon name="crop" size={16} /> {ctx.reposition ? 'Dragging picture' : 'Reposition'}</button>
            <button class="btn small" onClick={() => setFill({ scale: 1, ox: 0, oy: 0, rot: 0 })}>Reset</button>
          </div>
          <button class="btn small ghost" onClick={() => ctx.updateLayout((l) => ({ ...l, items: l.items.map((i) => (i.id === item.id ? { ...i, fills: Object.fromEntries(Object.entries(i.fills).filter(([k]) => k !== openingId)) } : i)) }))}>
            Show the frame’s original picture
          </button>
        </>
      )}
      <b style={{ fontSize: 14 }}>{ranked.length ? 'Suggested pictures' : 'No pictures yet'}</b>
      {!ranked.length && <button class="btn small" onClick={() => openModal({ kind: 'picture' })}><Icon name="plus" size={16} /> Add pictures</button>}
      <div class="tray-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
        {ranked.map((r) => (
          <SuggestedPic key={r.picture.id} blobId={r.picture.imageBlobId} label={r.fitLabel} on={fill?.pictureId === r.picture.id} used={used.has(r.picture.id)} onClick={() => assignPicture(ctx, item.id, openingId, r.picture.id)} />
        ))}
      </div>
    </div>
  );
}

function SuggestedPic({ blobId, label, on, used, onClick }: { blobId: string; label: string; on: boolean; used: boolean; onClick: () => void }) {
  const url = useBlobUrl(blobId);
  return (
    <button onClick={onClick} style={{ border: 0, padding: 0, background: 'transparent', cursor: 'pointer', borderRadius: 10, overflow: 'hidden', boxShadow: on ? '0 0 0 3px var(--accent)' : undefined, position: 'relative', aspectRatio: '1' }}>
      {url && <img src={url} style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: used && !on ? 0.5 : 1 }} />}
      <span style={{ position: 'absolute', left: 3, bottom: 3, fontSize: 9, padding: '1px 5px', borderRadius: 6, background: 'rgba(0,0,0,0.6)' }}>{label}</span>
    </button>
  );
}

function MultiInspector({ ctx, items }: { ctx: ArrangeCtx; items: PlacedItem[] }) {
  const boxes = items.map((i) => ({ item: i, b: footprint(i, ctx.frames.get(i.frameId)!) }));
  const u = unionBox(boxes.map((x) => x.b))!;
  const g = ctx.wallGeom;
  const gap = ctx.project.settings.gap;
  const apply = (fn: (b: (typeof boxes)[number]) => { dx: number; dy: number }) => {
    const moves = new Map(boxes.map((x) => [x.item.id, fn(x)]));
    ctx.updateLayout((l) => ({ ...l, items: l.items.map((i) => { const m = moves.get(i.id); return m && !i.locked ? { ...i, x: i.x + m.dx, y: i.y + m.dy } : i; }) }));
  };
  const distribute = (axis: 'x' | 'y', fixedGap?: number) => {
    const sorted = [...boxes].sort((a, b) => (axis === 'x' ? a.b.x - b.b.x : a.b.y - b.b.y));
    const size = (b: typeof boxes[number]['b']) => (axis === 'x' ? b.w : b.h);
    const start = axis === 'x' ? u.x : u.y;
    const span = axis === 'x' ? u.w : u.h;
    const total = sorted.reduce((a, s) => a + size(s.b), 0);
    const g2 = fixedGap ?? (span - total) / Math.max(1, sorted.length - 1);
    let pos = start;
    const target = new Map<string, number>();
    for (const s of sorted) { target.set(s.item.id, pos); pos += size(s.b) + g2; }
    apply((x) => ({ dx: axis === 'x' ? target.get(x.item.id)! - x.b.x : 0, dy: axis === 'y' ? target.get(x.item.id)! - x.b.y : 0 }));
  };
  return (
    <>
      <div class="panel-head">
        <div class="grow">
          <div style={{ fontSize: 22, fontWeight: 700 }}>{items.length} frames</div>
          <div class="muted small-text">Group is {fmtSize(u.w, u.h, ctx.units)}</div>
        </div>
        <button class="btn small icon-only ghost" onClick={() => ctx.setSelection([])}><Icon name="close" /></button>
      </div>
      <div class="panel-body">
        <div class="section-title">Align</div>
        <div class="row wrap">
          <button class="btn icon-only" title="Align left" onClick={() => apply((x) => ({ dx: u.x - x.b.x, dy: 0 }))}><Icon name="alignL" /></button>
          <button class="btn icon-only" title="Align centers" onClick={() => apply((x) => ({ dx: u.x + u.w / 2 - (x.b.x + x.b.w / 2), dy: 0 }))}><Icon name="alignCH" /></button>
          <button class="btn icon-only" title="Align right" onClick={() => apply((x) => ({ dx: u.x + u.w - (x.b.x + x.b.w), dy: 0 }))}><Icon name="alignR" /></button>
          <button class="btn icon-only" title="Align top" onClick={() => apply((x) => ({ dx: 0, dy: u.y - x.b.y }))}><Icon name="alignT" /></button>
          <button class="btn icon-only" title="Align middles" onClick={() => apply((x) => ({ dx: 0, dy: u.y + u.h / 2 - (x.b.y + x.b.h / 2) }))}><Icon name="alignCV" /></button>
          <button class="btn icon-only" title="Align bottom" onClick={() => apply((x) => ({ dx: 0, dy: u.y + u.h - (x.b.y + x.b.h) }))}><Icon name="alignB" /></button>
        </div>
        <div class="section-title">Spacing</div>
        <div class="row wrap">
          <button class="btn small" disabled={items.length < 3} onClick={() => distribute('x')}><Icon name="distH" size={16} /> Even ↔</button>
          <button class="btn small" disabled={items.length < 3} onClick={() => distribute('y')}><Icon name="distV" size={16} /> Even ↕</button>
          <button class="btn small" onClick={() => distribute('x', gap)}>{fmtLen(gap, ctx.units)} gaps ↔</button>
          <button class="btn small" onClick={() => distribute('y', gap)}>{fmtLen(gap, ctx.units)} gaps ↕</button>
        </div>
        <div class="section-title">Place group</div>
        <div class="row wrap">
          <button class="btn small" onClick={() => apply(() => ({ dx: 0, dy: g.eyeY - (u.y + u.h / 2) }))}>Center on eye level</button>
          <button class="btn small" onClick={() => apply(() => ({ dx: g.centerX - (u.x + u.w / 2), dy: 0 }))}>Center on wall</button>
        </div>
        <button class="btn danger" onClick={() => { ctx.updateLayout((l) => ({ ...l, items: l.items.filter((i) => !ctx.selection.includes(i.id)) })); ctx.setSelection([]); }}><Icon name="trash" /> Remove {items.length} frames</button>
      </div>
    </>
  );
}

// ---- Autofill ------------------------------------------------------------------------------

function AutofillPanel({ ctx }: { ctx: ArrangeCtx }) {
  const [mode, setMode] = useState<'fill' | 'fresh'>(ctx.layout.items.length ? 'fill' : 'fresh');
  const [ff, setFf] = useState<FrameFilter>(emptyFrameFilter);
  const [maxW, setMaxW] = useState(0);
  const [results, setResults] = useState<Suggestion[] | null>(null);
  const [pick, setPick] = useState(0);
  const g = ctx.wallGeom;
  const frames = [...ctx.frames.values()];
  const allowed = new Set(filterFrames(frames, ff).map((f) => f.id));

  const pool = () => {
    const out: { frameId: string; w: number; h: number }[] = [];
    for (const f of frames) {
      if (!allowed.has(f.id)) continue;
      const left = f.qty - (mode === 'fill' ? ctx.placedCount(f.id) : 0);
      for (let k = 0; k < left; k++) out.push({ frameId: f.id, w: f.widthIn, h: f.heightIn });
    }
    return out;
  };

  const run = () => {
    const placed = mode === 'fill' ? ctx.layout.items.filter((i) => ctx.frames.has(i.frameId)).map((i) => footprint(i, ctx.frames.get(i.frameId)!)) : [];
    const u = unionBox(placed);
    const fc = {
      pool: pool(),
      placed,
      bounds: g.hang,
      zones: ctx.project.zones,
      gap: ctx.project.settings.gap,
      centerX: u ? u.x + u.w / 2 : g.centerX,
      centerY: u ? u.y + u.h / 2 : g.eyeY,
      maxW: maxW || undefined,
    };
    if (!fc.pool.length) {
      toast(mode === 'fill' ? 'No leftover frames match — everything is already on the wall' : 'No frames match these filters');
      return;
    }
    const s = mode === 'fill' ? suggestFill(fc) : suggestFromScratch(fc);
    setResults(s);
    setPick(0);
    if (s.length) ctx.setPreview({ items: s[0].items, replace: mode === 'fresh' });
    else toast('Nothing fits — try a smaller set or free up wall space');
  };

  const apply = (asNew: boolean) => {
    const s = results?.[pick];
    if (!s) return;
    const newItems: PlacedItem[] = s.items.map((i) => ({ id: uid(), frameId: i.frameId, x: i.x, y: i.y, rotation: 0, fills: {} }));
    if (asNew) {
      ctx.commit((p) => {
        const l: Layout = { ...newLayout(`${s.name} ${p.layouts.length + 1}`), items: mode === 'fill' ? [...activeLayoutOf(p).items, ...newItems] : newItems };
        return { ...p, layouts: [...p.layouts, l], activeLayoutId: l.id };
      });
    } else {
      ctx.updateLayout((l) => ({ ...l, items: mode === 'fill' ? [...l.items, ...newItems] : newItems }));
    }
    ctx.setPreview(null);
    setResults(null);
    toast(asNew ? 'Saved as a new layout' : 'Applied');
  };

  const fillPictures = () => {
    const used = new Set(ctx.layout.items.flatMap((i) => Object.values(i.fills).map((f) => f.pictureId)));
    const pics = [...ctx.pictures.values()];
    if (!pics.length) return toast('Add some pictures first');
    let n = 0;
    const items = ctx.layout.items.map((it) => {
      const f = ctx.frames.get(it.frameId);
      if (!f) return it;
      const fills = { ...it.fills };
      for (const o of f.openings) {
        if (fills[o.id]) continue;
        const best = rankPictures(o, pics, used, []).find((r) => !used.has(r.picture.id));
        if (!best) continue;
        used.add(best.picture.id);
        fills[o.id] = { pictureId: best.picture.id, scale: 1, ox: 0, oy: 0, rot: 0 };
        n++;
      }
      return { ...it, fills };
    });
    if (!n) return toast('No empty openings, or no unused pictures left');
    ctx.updateLayout((l) => ({ ...l, items }));
    toast(`Filled ${n} opening${n === 1 ? '' : 's'}`);
  };

  useEffect(() => () => ctx.setPreview(null), []);

  return (
    <>
      <Segmented value={mode} onChange={(m) => { setMode(m); setResults(null); ctx.setPreview(null); }} options={[{ value: 'fill', label: 'Add to current' }, { value: 'fresh', label: 'Start fresh' }]} />
      <div class="hint">
        {mode === 'fill'
          ? <>Suggests where your <b>leftover frames</b> could go around what’s already on the wall.</>
          : <>Builds complete arrangements in different styles, centered on eye level.</>}
      </div>
      <div class="section-title">Use frames matching</div>
      <FrameFilterBar frames={frames} value={ff} onChange={setFf} compact />
      <div class="faint small-text">{pool().length} frame{pool().length === 1 ? '' : 's'} available</div>
      <LengthInput label="Max arrangement width (optional)" value={maxW} onChange={setMaxW} placeholder="no limit" />
      <button class="btn primary" data-testid="autofill-run" onClick={run}><Icon name="sparkles" /> Suggest layouts</button>
      {results && results.length > 0 && (
        <div class="col" style={{ gap: 8 }}>
          {results.map((s, k) => (
            <button key={k} class={`suggestion ${k === pick ? 'on' : ''}`} data-testid="suggestion" onClick={() => { setPick(k); ctx.setPreview({ items: s.items, replace: mode === 'fresh' }); }}>
              <div style={{ fontWeight: 650 }}>{s.name}</div>
              <div class="small-text muted">{s.description} · {s.items.length} frame{s.items.length === 1 ? '' : 's'}</div>
            </button>
          ))}
          <div class="row">
            <button class="btn primary grow" data-testid="autofill-apply" onClick={() => apply(false)}><Icon name="check" /> Apply</button>
            <button class="btn grow" onClick={() => apply(true)}><Icon name="layers" /> As new layout</button>
          </div>
        </div>
      )}
      <div class="section-title">Pictures</div>
      <button class="btn" onClick={fillPictures}><Icon name="picture" /> Fill empty openings with pictures</button>
    </>
  );
}

function activeLayoutOf(p: Project) {
  return p.layouts.find((l) => l.id === p.activeLayoutId) ?? p.layouts[0];
}

// ---- Paint -----------------------------------------------------------------------------------

const DEFAULT_PAINT: WallPaint = { hex: '', name: '', strength: 1, tolerance: 0.6 };

function PaintPanel({ ctx }: { ctx: ArrangeCtx }) {
  const wall = ctx.project.wall;
  const [family, setFamily] = useState('All');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'idle' | 'detecting' | 'painting'>('idle');
  // Highlight while there's no colour yet or while touching up; otherwise show the real paint.
  const [showArea, setShowArea] = useState(!wall?.paint?.hex);
  const showAreaRef = useRef(showArea);
  showAreaRef.current = showArea;
  const paint: WallPaint = wall?.paint ?? DEFAULT_PAINT;
  const list = useMemo(() => SW_PAINTS.filter((p) => (family === 'All' || p.family === family) && `${p.name} ${p.code}`.toLowerCase().includes(q.toLowerCase())), [family, q]);
  const job = useRef(0);
  const lastOverlay = useRef<Parameters<ArrangeCtx['setMaskOverlay']>[0]>(null);

  const savePaint = (next: WallPaint, extra: Partial<NonNullable<Project['wall']>> = {}) => {
    const p = getProject(ctx.project.id)!;
    return saveProject({ ...p, wall: { ...p.wall!, paint: next, ...extra } }, false);
  };

  // Re-detect (fast) and repaint (slower) whenever the paint settings, zones or wall change.
  const detectKey = JSON.stringify([wall?.sourceBlobId, wall?.quad, wall?.ceilingHeight, paint.tolerance, paint.taps, paint.strokes, ctx.project.zones]);
  const paintKey = JSON.stringify([detectKey, paint.hex, paint.strength]);
  useEffect(() => {
    if (!wall) return;
    const my = ++job.current;
    const t = setTimeout(async () => {
      setStatus('detecting');
      await nextFrame();
      const { mask } = await wallMaskFor(wall, ctx.project.zones, paint);
      if (my !== job.current) return;
      lastOverlay.current = { url: previewUrl(mask), w: mask.w, h: mask.h, scale: mask.scale };
      if (showAreaRef.current) ctx.setMaskOverlay(lastOverlay.current);
      if (!paint.hex) { setStatus('idle'); return; }
      setStatus('painting');
      await nextFrame();
      const out = await applyPaint(wall, ctx.project.zones, paint);
      if (my !== job.current) return;
      const p = getProject(ctx.project.id)!;
      await saveProject({ ...p, wall: { ...p.wall!, ...out }, settings: { ...p.settings, showPaint: true } }, false);
      setStatus('idle');
    }, 250);
    return () => clearTimeout(t);
  }, [paintKey]);

  useEffect(() => () => { ctx.setMaskOverlay(null); ctx.setPaintTool('none'); }, []);

  if (!wall) return <div class="hint">Add a wall photo first to preview paint colors.</div>;

  const tools: { value: PaintTool; label: string; icon: string }[] = [
    { value: 'none', label: 'Auto', icon: 'wand' },
    { value: 'brush', label: 'Brush', icon: 'paint' },
    { value: 'erase', label: 'Erase', icon: 'minus' },
    { value: 'wand', label: 'Tap fill', icon: 'plus' },
  ];
  const touchUps = (paint.strokes?.length ?? 0) + (paint.taps?.length ?? 0);

  return (
    <>
      <div class="row" style={{ justifyContent: 'space-between' }}>
        <div class="row" style={{ gap: 8 }}>
          {paint.hex && <span style={{ width: 24, height: 24, borderRadius: 7, background: paint.hex, display: 'inline-block', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.3)' }} />}
          <b>{paint.hex ? paint.name || paint.hex : 'Pick a color'}</b>
        </div>
        {status !== 'idle' && <div class="row small-text muted" style={{ gap: 6 }}><div class="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />{status === 'detecting' ? 'Finding wall…' : 'Painting…'}</div>}
      </div>
      <Toggle label="Show new color" on={ctx.project.settings.showPaint && !!(ctx.mode === 'photo' ? wall.paintedSrcBlobId : wall.paintedBlobId)} onChange={(v) => ctx.commit((p) => ({ ...p, settings: { ...p.settings, showPaint: v } }))} />
      <Toggle label="Highlight painted area" on={showArea} onChange={(v) => { setShowArea(v); ctx.setMaskOverlay(v ? lastOverlay.current : null); }} />

      <div class="section-title">Painted area</div>
      <div class="segmented" style={{ width: '100%' }}>
        {tools.map((t) => (
          <button key={t.value} class={ctx.paintTool === t.value ? 'on' : ''} style={{ flex: 1, padding: '0 6px' }} data-testid={`paint-tool-${t.value}`} onClick={() => { ctx.setPaintTool(t.value); if (t.value !== 'none') { setShowArea(true); ctx.setMaskOverlay(lastOverlay.current); } }}>{t.label}</button>
        ))}
      </div>
      <div class="hint">
        {ctx.paintTool === 'none' && <>The whole wall is found automatically from your pinned area. Use <b>Sensitivity</b> to spread further or pull back.</>}
        {ctx.paintTool === 'brush' && <>Drag on the wall to <b>add</b> areas that were missed.</>}
        {ctx.paintTool === 'erase' && <>Drag to <b>remove</b> areas that shouldn’t be painted (trim, fixtures, other walls).</>}
        {ctx.paintTool === 'wand' && <>Tap a missed patch of wall to fill it.</>}
      </div>
      {(ctx.paintTool === 'brush' || ctx.paintTool === 'erase') && (
        <label class="field"><span>Brush size</span><input type="range" min={10} max={120} step={2} value={ctx.brushPx} onInput={(e) => ctx.setBrushPx(+(e.target as HTMLInputElement).value)} /></label>
      )}
      <label class="field">
        <span>Sensitivity · {Math.round(paint.tolerance * 100)}%</span>
        <input type="range" min={0} max={1} step={0.02} value={paint.tolerance} data-testid="paint-tolerance" onInput={(e) => savePaint({ ...paint, tolerance: +(e.target as HTMLInputElement).value })} />
      </label>
      <div class="row wrap">
        <button class="btn small" disabled={!touchUps} onClick={() => {
          const strokes = [...(paint.strokes ?? [])];
          if (strokes.length) strokes.pop();
          else return savePaint({ ...paint, taps: (paint.taps ?? []).slice(0, -1) });
          savePaint({ ...paint, strokes });
        }}><Icon name="undo" size={16} /> Undo touch-up</button>
        <button class="btn small" disabled={!touchUps} onClick={() => savePaint({ ...paint, strokes: [], taps: [] })}>Clear touch-ups</button>
      </div>
      {!wall.ceilingHeight && (
        <LengthInput label="Ceiling height (keeps paint off the ceiling)" value={ceilingHeightOf(wall) ?? 0} onChange={(v) => { const p = getProject(ctx.project.id)!; saveProject({ ...p, wall: { ...p.wall!, ceilingHeight: v } }, false); }} placeholder="e.g. 96" />
      )}

      <div class="section-title">Color</div>
      <input class="input" placeholder="Search Sherwin-Williams colors" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      <div class="chips scroll">
        {PAINT_FAMILIES.map((f) => <button key={f} class={`chip ${family === f ? 'on' : ''}`} onClick={() => setFamily(f)}>{f}</button>)}
      </div>
      <div class="swatch-grid">
        {list.map((p) => (
          <button key={p.code} class={`swatch ${paint.hex === p.hex ? 'on' : ''}`} onClick={() => { setShowArea(false); ctx.setMaskOverlay(null); ctx.setPaintTool('none'); savePaint({ ...paint, hex: p.hex, name: `${p.name} ${p.code}` }); }}>
            <div class="c" style={{ background: p.hex }} />
            <div class="l">{p.name}<br />{p.code}</div>
          </button>
        ))}
      </div>
      <div class="row">
        <span class="grow">Custom color</span>
        <input type="color" value={paint.hex || '#d1cbc1'} onChange={(e) => savePaint({ ...paint, hex: (e.target as HTMLInputElement).value, name: 'Custom' })} style={{ width: 54, height: 36, border: 0, background: 'transparent' }} />
      </div>
      <label class="field"><span>Strength</span><input type="range" min={0.2} max={1} step={0.05} value={paint.strength} onChange={(e) => savePaint({ ...paint, strength: +(e.target as HTMLInputElement).value })} /></label>
      <div class="faint small-text">Colors keep your photo’s real light and shadows. Screen colors are approximate — check a physical chip.</div>
    </>
  );
}

// ---- Zones -----------------------------------------------------------------------------------

function ZonesPanel({ ctx }: { ctx: ArrangeCtx }) {
  const zones = ctx.project.zones;
  const g = ctx.wallGeom;
  const upd = (z: Zone) => ctx.commit((p) => ({ ...p, zones: p.zones.map((x) => (x.id === z.id ? z : x)) }));
  return (
    <>
      <div class="hint">Mark outlets, switches, thermostats or furniture. <b>No-hang</b> zones keep frames (and autofill) away; <b>no-paint</b> zones are left untouched by the wall color preview. Drag zones on the wall to place them.</div>
      <button class="btn primary" onClick={() => ctx.commit((p) => ({ ...p, zones: [...p.zones, { id: uid(), label: `Zone ${p.zones.length + 1}`, x: g.centerX - 3, y: g.eyeY - 3, w: 6, h: 6, noHang: true, noPaint: true }] }))}>
        <Icon name="plus" /> Add zone
      </button>
      {zones.map((z) => (
        <div key={z.id} class="col glass" style={{ padding: 12, borderRadius: 14, gap: 8 }}>
          <div class="row">
            <input class="input" value={z.label} onChange={(e) => upd({ ...z, label: (e.target as HTMLInputElement).value })} />
            <button class="btn icon-only danger" onClick={() => ctx.commit((p) => ({ ...p, zones: p.zones.filter((x) => x.id !== z.id) }))}><Icon name="trash" /></button>
          </div>
          <div class="row">
            <div class="grow"><LengthInput label="Width" value={z.w} onChange={(w) => upd({ ...z, w })} /></div>
            <div class="grow"><LengthInput label="Height" value={z.h} onChange={(h) => upd({ ...z, h })} /></div>
          </div>
          <Toggle label="No hanging" on={z.noHang} onChange={(v) => upd({ ...z, noHang: v })} />
          <Toggle label="No paint" on={z.noPaint} onChange={(v) => upd({ ...z, noPaint: v })} />
        </div>
      ))}
      <Toggle label="Show zones on the wall" on={ctx.project.settings.showZones} onChange={(v) => ctx.commit((p) => ({ ...p, settings: { ...p.settings, showZones: v } }))} />
    </>
  );
}

// ---- Wall & spacing -------------------------------------------------------------------------

function WallPanel({ ctx }: { ctx: ArrangeCtx }) {
  const st = ctx.project.settings;
  const set = (patch: Partial<typeof st>) => ctx.commit((p) => ({ ...p, settings: { ...p.settings, ...patch } }));
  const items = ctx.layout.items.filter((i) => ctx.frames.has(i.frameId));
  const u = unionBox(items.map((i) => footprint(i, ctx.frames.get(i.frameId)!)));
  const g = ctx.wallGeom;
  const w = ctx.project.wall;
  const moveAll = (dx: number, dy: number) => ctx.updateLayout((l) => ({ ...l, items: l.items.map((i) => (i.locked ? i : { ...i, x: i.x + dx, y: i.y + dy })) }));
  return (
    <>
      {w ? (
        <div class="stat"><span class="muted">Measured area</span><b>{fmtSize(w.refW, w.refH, ctx.units)}</b></div>
      ) : (
        <div class="hint">You’re using a sample wall. Add a photo of your own wall to plan at real scale.</div>
      )}
      <button class="btn" onClick={() => openModal({ kind: 'wall', projectId: ctx.project.id })}><Icon name="camera" /> {w ? 'Change photo or measurements' : 'Add wall photo'}</button>
      <div class="section-title">Eye level</div>
      <LengthInput label="Height of eye-level line from floor" value={st.eyeLevel} onChange={(v) => set({ eyeLevel: v })} />
      <div class="faint small-text">Galleries hang art so its center sits around 57″ from the floor. You can also drag the yellow label on the wall.</div>
      <Toggle label="Show eye-level line" on={st.showEyeLevel} onChange={(v) => set({ showEyeLevel: v })} />
      <div class="section-title">Spacing</div>
      <LengthInput label="Preferred gap between frames" value={st.gap} onChange={(v) => set({ gap: v })} />
      <Toggle label="Snap to edges, gaps & guides" on={st.snap} onChange={(v) => set({ snap: v })} />
      {u && (
        <>
          <div class="section-title">This arrangement</div>
          <div class="stat"><span class="muted">Overall size</span><b>{fmtSize(u.w, u.h, ctx.units)}</b></div>
          <div class="stat"><span class="muted">Center from floor</span><b>{fmtLen(g.floorY - (u.y + u.h / 2), ctx.units)}</b></div>
          <div class="stat"><span class="muted">Top edge from floor</span><b>{fmtLen(g.floorY - u.y, ctx.units)}</b></div>
          <div class="stat"><span class="muted">Frames</span><b>{items.length}</b></div>
          <div class="row wrap">
            <button class="btn small" onClick={() => moveAll(0, g.eyeY - (u.y + u.h / 2))}>Center on eye level</button>
            <button class="btn small" onClick={() => moveAll(g.centerX - (u.x + u.w / 2), 0)}>Center on wall</button>
          </div>
        </>
      )}
    </>
  );
}

// ---- Layouts ---------------------------------------------------------------------------------

function LayoutsPanel({ ctx }: { ctx: ArrangeCtx }) {
  const [editing, setEditing] = useState<string | null>(null);
  const p = ctx.project;
  return (
    <>
      <div class="hint">Keep several arrangements for the same wall and flip between them to compare.</div>
      <div class="col" style={{ gap: 6 }}>
        {p.layouts.map((l) => (
          <div key={l.id} class={`list-btn ${l.id === p.activeLayoutId ? 'on' : ''}`} onClick={() => { ctx.commit((pr) => ({ ...pr, activeLayoutId: l.id })); ctx.setSelection([]); }}>
            <div class="t">
              {editing === l.id ? (
                <input class="input" autoFocus value={l.name} onClick={(e) => e.stopPropagation()} onBlur={() => setEditing(null)} onKeyDown={(e) => e.key === 'Enter' && setEditing(null)} onInput={(e) => ctx.commit((pr) => ({ ...pr, layouts: pr.layouts.map((x) => (x.id === l.id ? { ...x, name: (e.target as HTMLInputElement).value } : x)) }))} />
              ) : (
                <div>{l.name}</div>
              )}
              <div>{l.items.length} frame{l.items.length === 1 ? '' : 's'}</div>
            </div>
            <button class="btn small icon-only ghost" title="Rename" onClick={(e) => { e.stopPropagation(); setEditing(l.id); }}><Icon name="pen" size={16} /></button>
            <button class="btn small icon-only ghost" title="Duplicate" onClick={(e) => { e.stopPropagation(); ctx.commit((pr) => { const c: Layout = { ...l, id: uid(), name: `${l.name} copy`, items: l.items.map((i) => ({ ...i, id: uid() })) }; return { ...pr, layouts: [...pr.layouts, c], activeLayoutId: c.id }; }); }}><Icon name="duplicate" size={16} /></button>
            <button class="btn small icon-only ghost danger" title="Delete" disabled={p.layouts.length < 2} onClick={(e) => { e.stopPropagation(); if (confirm(`Delete “${l.name}”?`)) ctx.commit((pr) => { const rest = pr.layouts.filter((x) => x.id !== l.id); return { ...pr, layouts: rest, activeLayoutId: pr.activeLayoutId === l.id ? rest[0].id : pr.activeLayoutId }; }); }}><Icon name="trash" size={16} /></button>
          </div>
        ))}
      </div>
      <button class="btn" onClick={() => ctx.commit((pr) => { const l = newLayout(`Layout ${pr.layouts.length + 1}`); return { ...pr, layouts: [...pr.layouts, l], activeLayoutId: l.id }; })}><Icon name="plus" /> New empty layout</button>
    </>
  );
}

// ---- Export ------------------------------------------------------------------------------------

function ExportPanel({ ctx }: { ctx: ArrangeCtx }) {
  const [area, setArea] = useState<'wall' | 'arrangement'>('wall');
  const [paint, setPaint] = useState(true);
  const [size, setSize] = useState(2400);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const make = async () => {
    setBusy(true);
    try {
      const b = await renderToBlob(ctx.project, ctx.layout, ctx.frames, ctx.pictures, { area, paint, maxSide: size });
      if (preview) URL.revokeObjectURL(preview);
      setPreview(URL.createObjectURL(b));
      return b;
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {ctx.mode === 'straight' && <Segmented value={area} onChange={setArea} options={[{ value: 'wall', label: 'Whole wall' }, { value: 'arrangement', label: 'Arrangement' }]} />}
      {ctx.mode === 'photo' && <div class="hint">Exports your photo with the frames in its perspective. Switch to <b>Straight-on</b> to export a squared-up view instead.</div>}
      <Toggle label="Include wall color" on={paint} onChange={setPaint} />
      <Segmented value={String(size) as '1600'} onChange={(v) => setSize(+v)} options={[{ value: '1600', label: 'Medium' }, { value: '2400', label: 'Large' }, { value: '4000', label: 'Max' }] as { value: '1600'; label: string }[]} />
      <button class="btn" disabled={busy} onClick={make}><Icon name="eye" /> Preview</button>
      {preview && <img src={preview} style={{ width: '100%', borderRadius: 12 }} />}
      <button class="btn primary" disabled={busy} data-testid="export-share" onClick={async () => { const b = await make(); await shareOrDownload(b, `${ctx.project.name} - ${ctx.layout.name}.png`); }}>
        <Icon name="share" /> {busy ? 'Rendering…' : 'Share or save image'}
      </button>
    </>
  );
}

function round1(v: number) {
  return Math.round(v * 10) / 10;
}
