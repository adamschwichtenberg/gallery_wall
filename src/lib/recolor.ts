// Wall paint preview that keeps the photo's real lighting.
//
// A photographed wall pixel is roughly  paint colour × light arriving at that spot.
// Dividing each pixel by the wall's original paint colour recovers the light (including its
// warm/cool tint, shadows and falloff); multiplying that light by the new paint colour gives
// the repainted pixel. Working in linear light keeps the maths physically meaningful.
import { downscale, hexToRgb, LIN_LUT, linearToSrgb, type Img } from './imaging';
import { pointInPolygon } from './geometry';
import type { Pt } from './types';

export interface MaskOptions {
  /** The pinned wall rectangle in photo pixels; its middle seeds the detection. */
  seedQuad: Pt[];
  /** Areas never to paint (photo-pixel polygons). */
  exclude: Pt[][];
  /** Paint only inside this polygon (the wall plane between floor and ceiling), if given. */
  clip?: Pt[];
  /** 0..1 — how far the detection spreads. */
  tolerance: number;
  /** Extra "tap to fill" seeds (photo pixels). */
  taps: Pt[];
  /** Manual touch-ups (photo pixels). */
  strokes: { mode: 'add' | 'erase'; r: number; pts: Pt[] }[];
}

/** A soft mask at working resolution (values 0..1). */
export interface SmallMask { m: Float32Array; w: number; h: number; scale: number }

/**
 * Detect a painted surface across the photo.
 *
 * Geodesic region growing: starting inside the pinned area, the cost of stepping from one pixel
 * to the next is how much the colour/brightness changes *beyond the wall's own texture noise*
 * (measured from the seed area, so orange-peel or knockdown texture is free). Gradual drifts from
 * mixed warm/cool lighting cost little, crisp edges (trim, outlets, the ceiling line) cost a lot.
 * A pixel belongs to the wall if it can be reached cheaply enough; Sensitivity sets the budget.
 */
export function detectWallMask(img: Img, o: MaskOptions): SmallMask {
  const { img: small, scale } = downscale(img, 720);
  const w = small.width, h = small.height, n = w * h, d0 = small.data;
  // Light blur so sensor noise and fine texture don't read as edges.
  const d = boxBlur3(d0, w, h);
  const logL = new Float32Array(n), cr = new Float32Array(n), cg = new Float32Array(n), lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = LIN_LUT[d[i * 4] | 0], g = LIN_LUT[d[i * 4 + 1] | 0], b = LIN_LUT[d[i * 4 + 2] | 0];
    const s = r + g + b + 1e-4;
    lum[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    logL[i] = Math.log(lum[i] + 0.004);
    cr[i] = r / s;
    cg[i] = g / s;
  }
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h;

  // Excluded pixels (no-paint zones, other surfaces, outside the allowed region).
  const excluded = new Uint8Array(n);
  const rasterise = (poly: Pt[], value: number, invert = false) => {
    const pp = poly.map((p) => ({ x: p.x * scale, y: p.y * scale }));
    if (invert) {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!pointInPolygon({ x, y }, pp)) excluded[y * w + x] = value;
      return;
    }
    const bx0 = Math.max(0, Math.floor(Math.min(...pp.map((p) => p.x)))), bx1 = Math.min(w - 1, Math.ceil(Math.max(...pp.map((p) => p.x))));
    const by0 = Math.max(0, Math.floor(Math.min(...pp.map((p) => p.y)))), by1 = Math.min(h - 1, Math.ceil(Math.max(...pp.map((p) => p.y))));
    for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) if (pointInPolygon({ x, y }, pp)) excluded[y * w + x] = value;
  };
  for (const poly of o.exclude) rasterise(poly, 1);
  if (o.clip && o.clip.length > 2) rasterise(o.clip, 1, true);

  // Seeds: points well inside the pinned area.
  const seedPoly = o.seedQuad.map((p) => ({ x: p.x * scale, y: p.y * scale }));
  const cx = seedPoly.reduce((a, p) => a + p.x, 0) / seedPoly.length, cy = seedPoly.reduce((a, p) => a + p.y, 0) / seedPoly.length;
  const inner = seedPoly.map((p) => ({ x: cx + (p.x - cx) * 0.6, y: cy + (p.y - cy) * 0.6 }));
  const ib = { x0: Math.min(...inner.map((p) => p.x)), x1: Math.max(...inner.map((p) => p.x)), y0: Math.min(...inner.map((p) => p.y)), y1: Math.max(...inner.map((p) => p.y)) };
  const stepS = Math.max(2, Math.round(Math.min(ib.x1 - ib.x0, ib.y1 - ib.y0) / 40));
  const seeds: number[] = [];
  for (let y = Math.floor(ib.y0); y <= ib.y1; y += stepS) for (let x = Math.floor(ib.x0); x <= ib.x1; x += stepS) {
    if (inside(x, y) && !excluded[y * w + x] && pointInPolygon({ x, y }, inner)) seeds.push(y * w + x);
  }
  if (!seeds.length) { const c = { x: Math.round(cx), y: Math.round(cy) }; if (inside(c.x, c.y)) seeds.push(c.y * w + c.x); }

  const med = (a: ArrayLike<number>) => Array.from(a).sort((p, q) => p - q)[a.length >> 1] ?? 0;
  const ref = { r: med(seeds.map((i) => cr[i])), g: med(seeds.map((i) => cg[i])), l: med(seeds.map((i) => logL[i])) };

  // How different neighbouring pixels are, weighted so chroma and brightness edges compare.
  const diff = (i: number, j: number) => Math.hypot((cr[j] - cr[i]) * 60, (cg[j] - cg[i]) * 60, (logL[j] - logL[i]) * 2.2);
  // Texture noise floor, measured on the seeds: typical neighbour differences on plain wall.
  const noise: number[] = [];
  for (const i of seeds) { const x = i % w; if (x < w - 1) noise.push(diff(i, i + 1)); if (i + w < n) noise.push(diff(i, i + w)); }
  noise.sort((a, b) => a - b);
  const floor = (noise[Math.floor(noise.length * 0.9)] ?? 0.05) * 1.25 + 0.01;

  const t = Math.max(0, Math.min(1, o.tolerance));
  const budget = 0.2 + t * t * 3.2;
  const globalTol = 0.06 + t * 0.3;
  const mask = new Uint8Array(n);
  const dist = new Float64Array(n);

  const grow = (starts: number[], rr: number, rg: number, rl: number) => {
    const ok = (i: number) => !excluded[i] && Math.hypot(cr[i] - rr, cg[i] - rg) < globalTol && logL[i] > rl - 3 && logL[i] < rl + 1.6;
    dist.fill(Infinity);
    const heap = new MinHeap(n >> 2);
    for (const i of starts) if (ok(i)) { dist[i] = 0; heap.push(0, i); }
    while (heap.size) {
      const [di, i] = heap.pop();
      if (di > dist[i]) continue;
      mask[i] = 1;
      const x = i % w;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i + w < n ? i + w : -1];
      for (const j of nb) {
        if (j < 0 || !ok(j)) continue;
        const nd = di + Math.max(0, diff(i, j) - floor) + 0.0005;
        if (nd <= budget && nd < dist[j] - 1e-9) { dist[j] = nd; heap.push(nd, j); }
      }
    }
  };
  grow(seeds, ref.r, ref.g, ref.l);
  // Tap-to-fill: grow from each tap using that spot's own colour as the reference.
  for (const tp of o.taps) {
    const x = Math.round(tp.x * scale), y = Math.round(tp.y * scale);
    if (!inside(x, y)) continue;
    const i = y * w + x;
    const ring: number[] = [];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (inside(x + dx, y + dy)) ring.push((y + dy) * w + x + dx);
    grow(ring, cr[i], cg[i], logL[i]);
  }

  // Close pin-holes from wall texture.
  let soft = boxBlur(mask, w, h, 2);
  for (let i = 0; i < n; i++) soft[i] = soft[i] > 0.45 ? 1 : 0;

  // Manual brush / eraser strokes win over detection.
  for (const s of o.strokes) {
    const r = Math.max(1, s.r * scale);
    const v = s.mode === 'add' ? 1 : 0;
    const pts = s.pts.map((p) => ({ x: p.x * scale, y: p.y * scale }));
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k], b = pts[Math.min(pts.length - 1, k + 1)];
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (r * 0.5)));
      for (let q = 0; q <= steps; q++) {
        const cx = a.x + ((b.x - a.x) * q) / steps, cy = a.y + ((b.y - a.y) * q) / steps;
        for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++)
          for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++)
            if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) soft[y * w + x] = v;
      }
    }
  }
  for (let i = 0; i < n; i++) if (excluded[i]) soft[i] = 0;
  soft = boxBlur(soft, w, h, 1);
  return { m: soft, w, h, scale };
}

/** Upsample a working-resolution mask to full size (0..255). */
export function upsampleMask(s: SmallMask, W: number, H: number): Uint8Array {
  const out = new Uint8Array(W * H);
  const { m, w, h, scale } = s;
  for (let y = 0; y < H; y++) {
    const sy = Math.min(h - 1, Math.max(0, (y + 0.5) * scale - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(h - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < W; x++) {
      const sx = Math.min(w - 1, Math.max(0, (x + 0.5) * scale - 0.5));
      const x0 = Math.floor(sx), x1 = Math.min(w - 1, x0 + 1), fx = sx - x0;
      const a = m[y0 * w + x0] + (m[y0 * w + x1] - m[y0 * w + x0]) * fx;
      const b = m[y1 * w + x0] + (m[y1 * w + x1] - m[y1 * w + x0]) * fx;
      out[y * W + x] = Math.round((a + (b - a) * fy) * 255);
    }
  }
  return out;
}

/** A translucent highlight of the mask, for showing what will be painted. */
export function maskPreview(s: SmallMask, rgb: [number, number, number] = [79, 141, 255]): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = s.w;
  c.height = s.h;
  const ctx = c.getContext('2d')!;
  const id = ctx.createImageData(s.w, s.h);
  for (let i = 0; i < s.m.length; i++) {
    id.data[i * 4] = rgb[0];
    id.data[i * 4 + 1] = rgb[1];
    id.data[i * 4 + 2] = rgb[2];
    id.data[i * 4 + 3] = Math.round(s.m[i] * 70);
  }
  ctx.putImageData(id, 0, 0);
  return c;
}

function boxBlur(src: ArrayLike<number>, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / (2 * r + 1);
      acc += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / (2 * r + 1);
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/** Repaint masked pixels with `hex`, preserving the original light. Returns a new image. */
/** Repaint masked pixels of `img`. Writes into `into` (e.g. an earlier surface's result) if given. */
export function repaint(img: Img, mask: Uint8Array, hex: string, strength: number, into?: Uint8ClampedArray): Img {
  const d = img.data, n = img.width * img.height;
  // Estimate the original paint colour: median linear RGB of confidently-masked pixels.
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];
  const step = Math.max(1, Math.floor(n / 40000));
  for (let i = 0; i < n; i += step) {
    if (mask[i] < 250) continue;
    rs.push(LIN_LUT[d[i * 4]]); gs.push(LIN_LUT[d[i * 4 + 1]]); bs.push(LIN_LUT[d[i * 4 + 2]]);
  }
  const med = (a: number[]) => [...a].sort((p, q) => p - q)[a.length >> 1] ?? 0.5;
  // The median is a mid-lit pixel; scale it so typical light ≈ 1 (keeps bright spots bright).
  const base = [med(rs), med(gs), med(bs)].map((v) => Math.max(0.02, v));
  const [tr, tg, tb] = hexToRgb(hex).map((v) => LIN_LUT[v]);
  const target = [tr, tg, tb];
  const out = into ?? new Uint8ClampedArray(d);
  for (let i = 0; i < n; i++) {
    const m = (mask[i] / 255) * strength;
    if (m <= 0) continue;
    const o = i * 4;
    for (let c = 0; c < 3; c++) {
      const lin = LIN_LUT[d[o + c]];
      const light = lin / base[c];
      // Soft-clip very bright light so repainting darker never produces flat white patches.
      const v = target[c] * light;
      const painted = v > 0.9 ? 0.9 + (1 - Math.exp(-(v - 0.9) * 4)) * 0.1 : v;
      out[o + c] = linearToSrgb(lin + (painted - lin) * m);
    }
  }
  return { data: out, width: img.width, height: img.height };
}


function boxBlur3(src: Uint8ClampedArray, w: number, h: number): Float32Array {
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0, cnt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            sum += src[(yy * w + xx) * 4 + c];
            cnt++;
          }
        }
        out[(y * w + x) * 4 + c] = sum / cnt;
      }
    }
  }
  return out;
}

/** Binary min-heap of (priority, index) pairs. */
class MinHeap {
  private p: Float64Array;
  private v: Int32Array;
  size = 0;
  constructor(cap: number) {
    this.p = new Float64Array(Math.max(16, cap));
    this.v = new Int32Array(Math.max(16, cap));
  }
  push(pri: number, val: number) {
    if (this.size === this.p.length) {
      const np = new Float64Array(this.p.length * 2), nv = new Int32Array(this.v.length * 2);
      np.set(this.p); nv.set(this.v);
      this.p = np; this.v = nv;
    }
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.p[parent] <= pri) break;
      this.p[i] = this.p[parent]; this.v[i] = this.v[parent];
      i = parent;
    }
    this.p[i] = pri; this.v[i] = val;
  }
  pop(): [number, number] {
    const top: [number, number] = [this.p[0], this.v[0]];
    const lp = this.p[--this.size], lv = this.v[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.p[c + 1] < this.p[c]) c++;
      if (this.p[c] >= lp) break;
      this.p[i] = this.p[c]; this.v[i] = this.v[c];
      i = c;
    }
    this.p[i] = lp; this.v[i] = lv;
    return top;
  }
}
