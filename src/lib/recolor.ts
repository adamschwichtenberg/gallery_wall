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
 * Detect the painted wall across the whole photo.
 *
 * Real rooms mix warm and cool light, so a wall's colour drifts across the photo. The fill
 * compares each pixel with its neighbour (gradual drift is allowed) and only loosely with the
 * wall's reference colour, and stops at edges — trim, outlets, fixtures, the ceiling line.
 */
export function detectWallMask(img: Img, o: MaskOptions): SmallMask {
  const { img: small, scale } = downscale(img, 720);
  const w = small.width, h = small.height, n = w * h, d = small.data;
  const lum = new Float32Array(n), cr = new Float32Array(n), cg = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = LIN_LUT[d[i * 4]], g = LIN_LUT[d[i * 4 + 1]], b = LIN_LUT[d[i * 4 + 2]];
    const s = r + g + b + 1e-4;
    lum[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    cr[i] = r / s;
    cg[i] = g / s;
  }
  const quad = o.seedQuad.map((p) => ({ x: p.x * scale, y: p.y * scale }));
  const at = (u: number, v: number) => {
    // Bilinear point inside the pinned quad (TL, TR, BR, BL).
    const top = { x: quad[0].x + (quad[1].x - quad[0].x) * u, y: quad[0].y + (quad[1].y - quad[0].y) * u };
    const bot = { x: quad[3].x + (quad[2].x - quad[3].x) * u, y: quad[3].y + (quad[2].y - quad[3].y) * u };
    return { x: Math.round(top.x + (bot.x - top.x) * v), y: Math.round(top.y + (bot.y - top.y) * v) };
  };
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h;

  // Excluded pixels (no-paint zones).
  const excluded = new Uint8Array(n);
  for (const poly of o.exclude) {
    const pp = poly.map((p) => ({ x: p.x * scale, y: p.y * scale }));
    const bx0 = Math.max(0, Math.floor(Math.min(...pp.map((p) => p.x)))), bx1 = Math.min(w - 1, Math.ceil(Math.max(...pp.map((p) => p.x))));
    const by0 = Math.max(0, Math.floor(Math.min(...pp.map((p) => p.y)))), by1 = Math.min(h - 1, Math.ceil(Math.max(...pp.map((p) => p.y))));
    for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) if (pointInPolygon({ x, y }, pp)) excluded[y * w + x] = 1;
  }

  if (o.clip && o.clip.length > 2) {
    const cp = o.clip.map((p) => ({ x: p.x * scale, y: p.y * scale }));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!pointInPolygon({ x, y }, cp)) excluded[y * w + x] = 1;
  }

  // Reference paint colour from the middle of the pinned area.
  const refR: number[] = [], refG: number[] = [], refL: number[] = [];
  for (let u = 0.2; u <= 0.8; u += 0.05) for (let v = 0.2; v <= 0.8; v += 0.05) {
    const p = at(u, v);
    if (!inside(p.x, p.y) || excluded[p.y * w + p.x]) continue;
    const i = p.y * w + p.x;
    refR.push(cr[i]); refG.push(cg[i]); refL.push(lum[i]);
  }
  const med = (a: number[]) => [...a].sort((p, q) => p - q)[a.length >> 1] ?? 0;
  const mr = med(refR), mg = med(refG), ml = med(refL) || 0.5;

  // Edge strength on log luminance, so edges in shadow count as much as in bright areas.
  const logL = lum.map((v) => Math.log(v + 0.01));
  const grad = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = logL[i + 1] - logL[i - 1] + 0.5 * (logL[i - w + 1] - logL[i - w - 1] + logL[i + w + 1] - logL[i + w - 1]);
    const gy = logL[i + w] - logL[i - w] + 0.5 * (logL[i + w - 1] - logL[i - w - 1] + logL[i + w + 1] - logL[i - w + 1]);
    grad[i] = Math.hypot(gx, gy);
  }

  const t = Math.max(0, Math.min(1, o.tolerance));
  const localTol = 0.003 + t * 0.022;
  const globalTol = 0.06 + t * 0.3;
  const gradTol = 0.05 + t * 0.5;
  const mask = new Uint8Array(n);

  const flood = (seeds: number[], rr: number, rg: number, rl: number) => {
    const ok = (i: number) => !excluded[i] && Math.hypot(cr[i] - rr, cg[i] - rg) < globalTol && lum[i] > rl * 0.08 && lum[i] < rl * 6;
    const stack: number[] = [];
    for (const i of seeds) if (!mask[i] && ok(i)) { mask[i] = 1; stack.push(i); }
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w, y = (i / w) | 0;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of nb) {
        if (j < 0 || mask[j] || !ok(j)) continue;
        if (Math.hypot(cr[j] - cr[i], cg[j] - cg[i]) > localTol) continue;
        mask[j] = 1;
        if (grad[j] < gradTol) stack.push(j); // edge pixels are painted but don't spread
      }
    }
  };

  const seeds: number[] = [];
  for (let u = 0.25; u <= 0.75; u += 0.025) for (let v = 0.25; v <= 0.75; v += 0.025) {
    const p = at(u, v);
    if (inside(p.x, p.y)) {
      const i = p.y * w + p.x;
      if (grad[i] < gradTol) seeds.push(i);
    }
  }
  flood(seeds, mr, mg, ml);
  // Tap-to-fill: flood from each tap using that spot's own colour as the reference.
  for (const tp of o.taps) {
    const x = Math.round(tp.x * scale), y = Math.round(tp.y * scale);
    if (!inside(x, y)) continue;
    const i = y * w + x;
    const ring: number[] = [];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (inside(x + dx, y + dy)) ring.push((y + dy) * w + x + dx);
    flood(ring, cr[i], cg[i], lum[i] || ml);
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
    id.data[i * 4 + 3] = Math.round(s.m[i] * 120);
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
export function repaint(img: Img, mask: Uint8Array, hex: string, strength: number): Img {
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
  const out = new Uint8ClampedArray(d);
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

