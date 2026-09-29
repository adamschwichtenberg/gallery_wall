// Layout maths: footprints, snapping and the autofill suggestion engine.
import { rectsOverlap, rotatedSize, type Rect } from './geometry';
import type { Frame, Opening, Picture, PlacedItem, Zone } from './types';

export interface Box extends Rect { id: string }

export function footprint(item: PlacedItem, frame: Frame): Box {
  const s = rotatedSize(frame.widthIn, frame.heightIn, item.rotation);
  return { id: item.id, x: item.x - s.w / 2, y: item.y - s.h / 2, w: s.w, h: s.h };
}

export function unionBox(boxes: Rect[]): Rect | null {
  if (!boxes.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ---- Snapping ------------------------------------------------------------------

export interface Guide { axis: 'x' | 'y'; at: number; from: number; to: number; kind: 'edge' | 'center' | 'wall' | 'eye' }
export interface GapMark { axis: 'x' | 'y'; a: number; b: number; at: number }

export interface SnapResult { dx: number; dy: number; guides: Guide[]; gaps: GapMark[] }

/**
 * Snap a moving box to other boxes' edges/centres, to the preferred gap, and to wall guides.
 * `tol` is in inches (derived from a fixed number of screen pixels).
 */
export function snap(
  moving: Rect,
  others: Rect[],
  opts: { gap: number; tol: number; xLines: number[]; yLines: number[]; grid?: { step: number; ox: number; oy: number } },
): SnapResult {
  const mx = [moving.x, moving.x + moving.w / 2, moving.x + moving.w];
  const my = [moving.y, moving.y + moving.h / 2, moving.y + moving.h];
  type Cand = { d: number; guide?: Guide; gap?: GapMark };
  let bestX: Cand = { d: Infinity }, bestY: Cand = { d: Infinity };
  const consider = (axis: 'x' | 'y', delta: number, extra: Omit<Cand, 'd'>) => {
    if (Math.abs(delta) > opts.tol) return;
    const cur = axis === 'x' ? bestX : bestY;
    if (Math.abs(delta) < Math.abs(cur.d) - 1e-6) {
      if (axis === 'x') bestX = { d: delta, ...extra };
      else bestY = { d: delta, ...extra };
    }
  };
  for (const o of others) {
    const ox = [o.x, o.x + o.w / 2, o.x + o.w];
    const oy = [o.y, o.y + o.h / 2, o.y + o.h];
    const vOverlap = moving.y < o.y + o.h + opts.gap * 4 && o.y < moving.y + moving.h + opts.gap * 4;
    const hOverlap = moving.x < o.x + o.w + opts.gap * 4 && o.x < moving.x + moving.w + opts.gap * 4;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      if ((i === 1) !== (j === 1)) continue; // edge↔edge or centre↔centre
      const kind = i === 1 ? 'center' : 'edge';
      consider('x', ox[j] - mx[i], { guide: { axis: 'x', at: ox[j], from: Math.min(o.y, moving.y), to: Math.max(o.y + o.h, moving.y + moving.h), kind } });
      consider('y', oy[j] - my[i], { guide: { axis: 'y', at: oy[j], from: Math.min(o.x, moving.x), to: Math.max(o.x + o.w, moving.x + moving.w), kind } });
    }
    if (vOverlap) {
      const midY = (Math.max(o.y, moving.y) + Math.min(o.y + o.h, moving.y + moving.h)) / 2;
      consider('x', o.x + o.w + opts.gap - moving.x, { gap: { axis: 'x', a: o.x + o.w, b: o.x + o.w + opts.gap, at: midY } });
      consider('x', o.x - opts.gap - (moving.x + moving.w), { gap: { axis: 'x', a: o.x - opts.gap, b: o.x, at: midY } });
    }
    if (hOverlap) {
      const midX = (Math.max(o.x, moving.x) + Math.min(o.x + o.w, moving.x + moving.w)) / 2;
      consider('y', o.y + o.h + opts.gap - moving.y, { gap: { axis: 'y', a: o.y + o.h, b: o.y + o.h + opts.gap, at: midX } });
      consider('y', o.y - opts.gap - (moving.y + moving.h), { gap: { axis: 'y', a: o.y - opts.gap, b: o.y, at: midX } });
    }
  }
  if (opts.grid && opts.grid.step > 0) {
    // Snap edges and centre to the grid (origin: left edge of the measured area, and the floor).
    const g = opts.grid;
    for (const v of mx) consider('x', g.ox + Math.round((v - g.ox) / g.step) * g.step - v, {});
    for (const v of my) consider('y', g.oy - Math.round((g.oy - v) / g.step) * g.step - v, {});
  }
  for (const x of opts.xLines) consider('x', x - mx[1], { guide: { axis: 'x', at: x, from: moving.y - 12, to: moving.y + moving.h + 12, kind: 'wall' } });
  for (const y of opts.yLines) consider('y', y - my[1], { guide: { axis: 'y', at: y, from: moving.x - 12, to: moving.x + moving.w + 12, kind: 'eye' } });
  const guides: Guide[] = [], gaps: GapMark[] = [];
  if (bestX.guide) guides.push(bestX.guide);
  if (bestY.guide) guides.push(bestY.guide);
  if (bestX.gap) gaps.push(bestX.gap);
  if (bestY.gap) gaps.push(bestY.gap);
  return { dx: isFinite(bestX.d) ? bestX.d : 0, dy: isFinite(bestY.d) ? bestY.d : 0, guides, gaps };
}

// ---- Autofill -----------------------------------------------------------------------

export interface Bounds { x0: number; y0: number; x1: number; y1: number }

export interface FillContext {
  /** Frames available to place, one entry per physical copy. */
  pool: { frameId: string; w: number; h: number }[];
  placed: Rect[];
  bounds: Bounds; // hanging area (wall)
  zones: Zone[];
  gap: number;
  centerX: number;
  centerY: number; // usually the eye-level line
  /** Optional cap on the arrangement's overall size. */
  maxW?: number;
  maxH?: number;
}

export interface Suggestion { name: string; description: string; items: { frameId: string; x: number; y: number }[] }

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

function fits(r: Rect, ctx: FillContext, placed: Rect[]): boolean {
  const b = ctx.bounds;
  if (r.x < b.x0 || r.y < b.y0 || r.x + r.w > b.x1 || r.y + r.h > b.y1) return false;
  for (const z of ctx.zones) if (z.noHang && rectsOverlap(r, z, 0.5)) return false;
  for (const p of placed) if (rectsOverlap(r, p, ctx.gap - 0.01)) return false;
  return true;
}

interface GrowWeights { compact: number; aspect: number; align: number; bigFirst: number; jitter: number; wide: number }

/** Greedy growth: repeatedly attach the best-scoring frame next to what is already there. */
function grow(ctx: FillContext, w: GrowWeights, seed: number, limit = Infinity) {
  const rand = rng(seed);
  const placed = [...ctx.placed];
  const pool = [...ctx.pool];
  const out: { frameId: string; x: number; y: number; w: number; h: number }[] = [];
  const cx = ctx.centerX, cy = ctx.centerY;
  while (pool.length && out.length < limit) {
    let best: { i: number; r: Rect; s: number } | null = null;
    // Consider each distinct frame size once per round.
    const seen = new Set<string>();
    for (let i = 0; i < pool.length; i++) {
      const f = pool[i];
      const key = `${f.frameId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const cands: Rect[] = [];
      if (!placed.length) cands.push({ x: cx - f.w / 2, y: cy - f.h / 2, w: f.w, h: f.h });
      for (const p of placed) {
        const g = ctx.gap;
        const ys = [p.y, p.y + p.h / 2 - f.h / 2, p.y + p.h - f.h];
        const xs = [p.x, p.x + p.w / 2 - f.w / 2, p.x + p.w - f.w];
        for (const y of ys) {
          cands.push({ x: p.x + p.w + g, y, w: f.w, h: f.h });
          cands.push({ x: p.x - g - f.w, y, w: f.w, h: f.h });
        }
        for (const x of xs) {
          cands.push({ x, y: p.y + p.h + g, w: f.w, h: f.h });
          cands.push({ x, y: p.y - g - f.h, w: f.w, h: f.h });
        }
      }
      for (const r of cands) {
        if (!fits(r, ctx, placed)) continue;
        const u = unionBox([...placed, r])!;
        if (ctx.maxW && u.w > ctx.maxW) continue;
        if (ctx.maxH && u.h > ctx.maxH) continue;
        const ucx = u.x + u.w / 2, ucy = u.y + u.h / 2;
        // Stay centred on the target, stay compact, prefer a pleasing overall shape.
        let s = -w.compact * (Math.abs(ucx - cx) + Math.abs(ucy - cy));
        s -= w.aspect * Math.abs(Math.log(u.w / u.h / w.wide));
        s -= 0.02 * (u.w * u.h);
        s += w.bigFirst * Math.sqrt(r.w * r.h);
        // Reward alignment with existing edges/centres.
        let aligned = 0;
        for (const p of placed) {
          if (Math.abs(p.x - r.x) < 0.01 || Math.abs(p.x + p.w - r.x - r.w) < 0.01) aligned++;
          if (Math.abs(p.y - r.y) < 0.01 || Math.abs(p.y + p.h - r.y - r.h) < 0.01) aligned++;
          if (Math.abs(p.x + p.w / 2 - r.x - r.w / 2) < 0.01 || Math.abs(p.y + p.h / 2 - r.y - r.h / 2) < 0.01) aligned++;
        }
        s += w.align * Math.min(aligned, 3);
        s += w.jitter * rand();
        if (!best || s > best.s) best = { i, r, s };
      }
    }
    if (!best) break;
    const f = pool.splice(best.i, 1)[0];
    placed.push(best.r);
    out.push({ frameId: f.frameId, x: best.r.x + best.r.w / 2, y: best.r.y + best.r.h / 2, w: best.r.w, h: best.r.h });
  }
  return out;
}

/** Re-centre a set of placements on (cx, cy) if it still fits. */
function recentre<T extends { x: number; y: number; w: number; h: number }>(items: T[], ctx: FillContext): T[] {
  const u = unionBox(items.map((i) => ({ x: i.x - i.w / 2, y: i.y - i.h / 2, w: i.w, h: i.h })));
  if (!u) return items;
  const dx = ctx.centerX - (u.x + u.w / 2), dy = ctx.centerY - (u.y + u.h / 2);
  const moved = items.map((i) => ({ ...i, x: i.x + dx, y: i.y + dy }));
  const ok = moved.every((i, k) => fits({ x: i.x - i.w / 2, y: i.y - i.h / 2, w: i.w, h: i.h }, ctx, moved.filter((_, j) => j !== k).map((m) => ({ x: m.x - m.w / 2, y: m.y - m.h / 2, w: m.w, h: m.h }))));
  return ok ? moved : items;
}

/** Add leftover frames around what's already on the wall. */
export function suggestFill(ctx: FillContext): Suggestion[] {
  const sorted = { ...ctx, pool: [...ctx.pool].sort((a, b) => b.w * b.h - a.w * a.h) };
  const variants: [string, string, GrowWeights][] = [
    ['Balanced', 'Grows evenly around the centre', { compact: 1, aspect: 6, align: 3, bigFirst: 0.6, jitter: 0.5, wide: 1.4 }],
    ['Wide', 'A longer, lower arrangement', { compact: 0.6, aspect: 10, align: 3, bigFirst: 0.4, jitter: 0.5, wide: 2.6 }],
    ['Relaxed', 'Salon-style, less rigid', { compact: 0.8, aspect: 4, align: 0.8, bigFirst: 0.3, jitter: 6, wide: 1.2 }],
  ];
  const out: Suggestion[] = [];
  for (let v = 0; v < variants.length; v++) {
    const [name, description, w] = variants[v];
    const items = grow(sorted, w, 17 + v * 101);
    if (items.length) out.push({ name, description, items: items.map(({ frameId, x, y }) => ({ frameId, x, y })) });
  }
  return dedupe(out);
}

/** Build a new arrangement from scratch with a named style. */
export function suggestFromScratch(ctx: FillContext): Suggestion[] {
  const base = { ...ctx, placed: [] as Rect[] };
  const out: Suggestion[] = [];
  const bySize = [...ctx.pool].sort((a, b) => b.w * b.h - a.w * a.h);

  // Salon: largest in the middle, others grown around it.
  const salon = grow({ ...base, pool: bySize }, { compact: 1, aspect: 5, align: 2, bigFirst: 0.8, jitter: 1.5, wide: 1.5 }, 7);
  if (salon.length) out.push({ name: 'Salon', description: 'Largest piece anchors the centre', items: strip(recentre(salon, base)) });

  // Grid: rows of frames, each row centred, rows stacked around the eye line.
  const grid = gridLayout(base, bySize);
  if (grid.length) out.push({ name: 'Grid', description: 'Tidy rows with even spacing', items: strip(grid) });

  // Symmetric: a centrepiece with mirrored pairs.
  const sym = symmetricLayout(base, bySize);
  if (sym.length) out.push({ name: 'Symmetric', description: 'Mirrored pairs around a centrepiece', items: strip(sym) });

  // Linear: a single row along the eye line (great above a sofa or console).
  const row = rowLayout(base, bySize);
  if (row.length) out.push({ name: 'Single row', description: 'One line centred on eye level', items: strip(row) });
  return dedupe(out);
}

function strip(items: { frameId: string; x: number; y: number }[]) {
  return items.map(({ frameId, x, y }) => ({ frameId, x, y }));
}

function dedupe(s: Suggestion[]) {
  const seen = new Set<string>();
  return s.filter((x) => {
    const k = x.items.map((i) => `${i.frameId}@${i.x.toFixed(1)},${i.y.toFixed(1)}`).sort().join('|');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function gridLayout(ctx: FillContext, pool: FillContext['pool']) {
  const n = pool.length;
  if (!n) return [];
  const cols = Math.max(1, Math.round(Math.sqrt(n * 1.5)));
  const rows: (typeof pool)[] = [];
  for (let i = 0; i < n; i += cols) rows.push(pool.slice(i, i + cols));
  const g = ctx.gap;
  const rowH = rows.map((r) => Math.max(...r.map((f) => f.h)));
  const total = rowH.reduce((a, b) => a + b, 0) + g * (rows.length - 1);
  let y = ctx.centerY - total / 2;
  const out: { frameId: string; x: number; y: number; w: number; h: number }[] = [];
  rows.forEach((r, ri) => {
    const width = r.reduce((a, f) => a + f.w, 0) + g * (r.length - 1);
    let x = ctx.centerX - width / 2;
    for (const f of r) {
      out.push({ frameId: f.frameId, x: x + f.w / 2, y: y + rowH[ri] / 2, w: f.w, h: f.h });
      x += f.w + g;
    }
    y += rowH[ri] + g;
  });
  return validOnly(out, ctx);
}

function rowLayout(ctx: FillContext, pool: FillContext['pool']) {
  // Put the biggest in the middle, alternate the rest left/right.
  const order: typeof pool = [];
  pool.forEach((f, i) => (i % 2 ? order.push(f) : order.unshift(f)));
  const g = ctx.gap;
  const width = order.reduce((a, f) => a + f.w, 0) + g * (order.length - 1);
  let x = ctx.centerX - width / 2;
  const out = order.map((f) => {
    const item = { frameId: f.frameId, x: x + f.w / 2, y: ctx.centerY, w: f.w, h: f.h };
    x += f.w + g;
    return item;
  });
  return validOnly(out, ctx);
}

function symmetricLayout(ctx: FillContext, pool: FillContext['pool']) {
  if (!pool.length) return [];
  const rest = [...pool];
  const centre = rest.shift()!;
  const out: { frameId: string; x: number; y: number; w: number; h: number }[] = [
    { frameId: centre.frameId, x: ctx.centerX, y: ctx.centerY, w: centre.w, h: centre.h },
  ];
  // Pair up frames of (nearly) the same size.
  const pairs: [typeof centre, typeof centre][] = [];
  const singles: typeof rest = [];
  while (rest.length) {
    const a = rest.shift()!;
    const j = rest.findIndex((b) => Math.abs(b.w - a.w) <= 1 && Math.abs(b.h - a.h) <= 1);
    if (j >= 0) pairs.push([a, rest.splice(j, 1)[0]]);
    else singles.push(a);
  }
  const g = ctx.gap;
  const rects = () => out.map((o) => ({ x: o.x - o.w / 2, y: o.y - o.h / 2, w: o.w, h: o.h }));
  for (const [a, b] of pairs) {
    // Try positions for `a` on the left; mirror `b` on the right.
    let placedPair = false;
    const cur = rects();
    const cands: { x: number; y: number }[] = [];
    for (const p of cur) {
      for (const y of [p.y + p.h / 2, p.y + a.h / 2, p.y + p.h - a.h / 2]) cands.push({ x: p.x - g - a.w / 2, y });
      cands.push({ x: p.x + p.w / 2, y: p.y - g - a.h / 2 });
      cands.push({ x: p.x + p.w / 2, y: p.y + p.h + g + a.h / 2 });
    }
    cands.sort((u, v) => Math.hypot(u.x - ctx.centerX, (u.y - ctx.centerY) * 1.4) - Math.hypot(v.x - ctx.centerX, (v.y - ctx.centerY) * 1.4));
    for (const c of cands) {
      if (c.x + a.w / 2 > ctx.centerX - g / 2) continue;
      const ra = { x: c.x - a.w / 2, y: c.y - a.h / 2, w: a.w, h: a.h };
      const mx = 2 * ctx.centerX - c.x;
      const rb = { x: mx - b.w / 2, y: c.y - b.h / 2, w: b.w, h: b.h };
      if (fits(ra, ctx, cur) && fits(rb, ctx, [...cur, ra])) {
        out.push({ frameId: a.frameId, x: c.x, y: c.y, w: a.w, h: a.h }, { frameId: b.frameId, x: mx, y: c.y, w: b.w, h: b.h });
        placedPair = true;
        break;
      }
    }
    if (!placedPair) singles.push(a, b);
  }
  // Singles go on the axis, above or below.
  for (const s of singles) {
    const u = unionBox(rects())!;
    const above = { x: ctx.centerX - s.w / 2, y: u.y - g - s.h, w: s.w, h: s.h };
    const below = { x: ctx.centerX - s.w / 2, y: u.y + u.h + g, w: s.w, h: s.h };
    const cur = rects();
    const pick = [above, below].sort((p, q) => Math.abs(p.y + p.h / 2 - ctx.centerY) - Math.abs(q.y + q.h / 2 - ctx.centerY)).find((r) => fits(r, ctx, cur));
    if (pick) out.push({ frameId: s.frameId, x: pick.x + s.w / 2, y: pick.y + s.h / 2, w: s.w, h: s.h });
  }
  return recentre(out, ctx);
}

function validOnly<T extends { x: number; y: number; w: number; h: number }>(items: T[], ctx: FillContext): T[] {
  const acc: T[] = [];
  for (const i of items) {
    const r = { x: i.x - i.w / 2, y: i.y - i.h / 2, w: i.w, h: i.h };
    if (fits(r, ctx, acc.map((a) => ({ x: a.x - a.w / 2, y: a.y - a.h / 2, w: a.w, h: a.h })))) acc.push(i);
  }
  return acc;
}

// ---- Swap suggestions -------------------------------------------------------------------

/** Rank pictures for an opening: aspect-ratio fit first, then unused, then colour variety. */
export function rankPictures(opening: Opening, pictures: Picture[], used: Set<string>, nearbyColors: string[]) {
  const target = opening.w / opening.h;
  return pictures
    .map((p) => {
      const fit = Math.min(Math.abs(Math.log(p.aspect / target)), Math.abs(Math.log(1 / p.aspect / target)) + 0.15);
      let score = 1 - fit * 2;
      if (used.has(p.id)) score -= 0.6;
      if (nearbyColors.includes(p.tags.color)) score -= 0.1;
      return { picture: p, score, fitLabel: fit < 0.05 ? 'Perfect fit' : fit < 0.2 ? 'Good fit' : 'Will crop' };
    })
    .sort((a, b) => b.score - a.score);
}

/** Rank unplaced frames that could replace `current` in roughly the same footprint. */
export function rankFrameSwaps(current: Frame, candidates: Frame[]) {
  return candidates
    .filter((f) => f.id !== current.id)
    .map((f) => {
      const d = Math.abs(f.widthIn - current.widthIn) + Math.abs(f.heightIn - current.heightIn);
      const dr = Math.abs(f.heightIn - current.widthIn) + Math.abs(f.widthIn - current.heightIn);
      return { frame: f, delta: Math.min(d, dr), rotate: dr < d };
    })
    .sort((a, b) => a.delta - b.delta);
}
