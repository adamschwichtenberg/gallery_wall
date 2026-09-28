// Wall paint preview that keeps the photo's real lighting.
//
// A photographed wall pixel is roughly  paint colour × light arriving at that spot.
// Dividing each pixel by the wall's original paint colour recovers the light (including its
// warm/cool tint, shadows and falloff); multiplying that light by the new paint colour gives
// the repainted pixel. Working in linear light keeps the maths physically meaningful.
import { downscale, hexToRgb, LIN_LUT, linearToSrgb, type Img } from './imaging';
import type { Zone } from './types';

export interface PaintRegion {
  /** Pixel rectangle the paint may cover (the pinned wall area, or the whole image). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Build a soft 0..255 mask of wall pixels. */
export function wallMask(img: Img, region: PaintRegion, exclude: PaintRegion[], tolerance: number): Uint8Array {
  // Work at reduced resolution for speed, then upsample.
  const { img: small, scale } = downscale(img, 700);
  const w = small.width, h = small.height, n = w * h, d = small.data;
  const lum = new Float32Array(n);
  const cr = new Float32Array(n), cg = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = LIN_LUT[d[i * 4]], g = LIN_LUT[d[i * 4 + 1]], b = LIN_LUT[d[i * 4 + 2]];
    const s = r + g + b + 1e-4;
    lum[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    cr[i] = r / s;
    cg[i] = g / s;
  }
  const rx0 = Math.max(0, Math.floor(region.x0 * scale)), rx1 = Math.min(w, Math.ceil(region.x1 * scale));
  const ry0 = Math.max(0, Math.floor(region.y0 * scale)), ry1 = Math.min(h, Math.ceil(region.y1 * scale));
  const excluded = (x: number, y: number) =>
    exclude.some((e) => x >= e.x0 * scale && x <= e.x1 * scale && y >= e.y0 * scale && y <= e.y1 * scale);

  // Reference paint colour: median chromaticity of the central part of the region.
  const refR: number[] = [], refG: number[] = [], refL: number[] = [];
  for (let y = ry0 + ((ry1 - ry0) * 0.2) | 0; y < ry1 - (ry1 - ry0) * 0.2; y += 2)
    for (let x = rx0 + ((rx1 - rx0) * 0.2) | 0; x < rx1 - (rx1 - rx0) * 0.2; x += 2) {
      const i = y * w + x;
      if (d[i * 4 + 3] < 200 || excluded(x, y)) continue;
      refR.push(cr[i]); refG.push(cg[i]); refL.push(lum[i]);
    }
  const med = (a: number[]) => [...a].sort((p, q) => p - q)[a.length >> 1] ?? 0;
  const mr = med(refR), mg = med(refG), ml = med(refL) || 0.5;

  // Gradient magnitude (on log luminance so edges in shadows count as much as in highlights).
  const logL = lum.map((v) => Math.log(v + 0.01));
  const grad = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = logL[i + 1] - logL[i - 1] + 0.5 * (logL[i - w + 1] - logL[i - w - 1] + logL[i + w + 1] - logL[i + w - 1]);
    const gy = logL[i + w] - logL[i - w] + 0.5 * (logL[i + w - 1] - logL[i - w - 1] + logL[i + w + 1] - logL[i - w + 1]);
    grad[i] = Math.hypot(gx, gy);
  }
  // Real rooms mix warm and cool light, so the wall's colour drifts across the photo. Compare
  // each pixel with its neighbour (local drift is fine) and only loosely with the reference.
  const localTol = 0.004 + tolerance * 0.012;
  const globalTol = 0.08 + tolerance * 0.14;
  const gradTol = 0.06 + tolerance * 0.25;
  const similar = (i: number) =>
    d[i * 4 + 3] > 200 && Math.hypot(cr[i] - mr, cg[i] - mg) < globalTol && lum[i] > ml * 0.1 && lum[i] < ml * 5;

  // Flood fill from the reference area, stopping at edges (trim, outlets, fixtures).
  const mask = new Uint8Array(n);
  const stack: number[] = [];
  for (let y = ry0 + ((ry1 - ry0) * 0.3) | 0; y < ry1 - (ry1 - ry0) * 0.3; y += 6)
    for (let x = rx0 + ((rx1 - rx0) * 0.3) | 0; x < rx1 - (rx1 - rx0) * 0.3; x += 6) {
      const i = y * w + x;
      if (similar(i) && grad[i] < gradTol && !excluded(x, y)) { mask[i] = 1; stack.push(i); }
    }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w, y = (i / w) | 0;
    const nb = [x > rx0 ? i - 1 : -1, x < rx1 - 1 ? i + 1 : -1, y > ry0 ? i - w : -1, y < ry1 - 1 ? i + w : -1];
    for (const j of nb) {
      if (j < 0 || mask[j]) continue;
      const jx = j % w, jy = (j / w) | 0;
      if (!similar(j) || excluded(jx, jy)) continue;
      if (Math.hypot(cr[j] - cr[i], cg[j] - cg[i]) > localTol) continue;
      mask[j] = 1;
      // Edge pixels are painted but don't spread further.
      if (grad[j] < gradTol) stack.push(j);
    }
  }
  // Close pin-holes (texture speckle) with a small blur + threshold, then feather.
  let soft = boxBlur(mask, w, h, 2);
  for (let i = 0; i < n; i++) soft[i] = soft[i] > 0.45 ? 1 : 0;
  soft = boxBlur(soft, w, h, 1);

  // Upsample to full size (bilinear).
  const W = img.width, H = img.height;
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(h - 1, (y + 0.5) * scale - 0.5);
    const y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(h - 1, y0 + 1), fy = Math.max(0, sy - y0);
    for (let x = 0; x < W; x++) {
      const sx = Math.min(w - 1, (x + 0.5) * scale - 0.5);
      const x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(w - 1, x0 + 1), fx = Math.max(0, sx - x0);
      const a = soft[y0 * w + x0] + (soft[y0 * w + x1] - soft[y0 * w + x0]) * fx;
      const b = soft[y1 * w + x0] + (soft[y1 * w + x1] - soft[y1 * w + x0]) * fx;
      out[y * W + x] = Math.round((a + (b - a) * fy) * 255);
    }
  }
  return out;
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

export function zonesToPixelRects(zones: Zone[], x0: number, y0: number, ppi: number): PaintRegion[] {
  return zones
    .filter((z) => z.noPaint)
    .map((z) => ({ x0: (z.x - x0) * ppi, y0: (z.y - y0) * ppi, x1: (z.x + z.w - x0) * ppi, y1: (z.y + z.h - y0) * ppi }));
}
