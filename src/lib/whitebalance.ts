// Colour correction for photographed prints: room lighting (warm bulbs, cool daylight) tints the
// photo. We look for what should be neutral — the paper border or white areas of the print — and
// scale each channel so it becomes neutral again, in linear light. If nothing neutral is found we
// fall back to a gentler grey-world estimate.
import { downscale, LIN_LUT, linearToSrgb, type Img } from './imaging';
import type { ColorAdjust } from './types';

export interface WbEstimate {
  /** Per-channel multipliers (linear light) that neutralise the lighting. */
  gains: [number, number, number];
  /** Suggested exposure multiplier so the brightest paper sits near white. */
  exposure: number;
  /** How the estimate was made, for the UI. */
  method: 'white' | 'gray';
}

export const DEFAULT_COLOR: ColorAdjust = { auto: true, warmth: 0, tint: 0, exposure: 0 };

export function estimateWhiteBalance(src: Img, opts: { include?: (x: number, y: number) => boolean; grayStrength?: number } = {}): WbEstimate {
  const { img, scale } = downscale(src, 400);
  const d = img.data, n = img.width * img.height;
  // Only consider pixels that belong to the subject (e.g. inside a frame's cut-out).
  const use = new Uint8Array(n);
  let used = 0;
  for (let i = 0; i < n; i++) {
    const ok = d[i * 4 + 3] > 128 && (!opts.include || opts.include((i % img.width) / scale, Math.floor(i / img.width) / scale));
    use[i] = ok ? 1 : 0;
    used += use[i];
  }
  if (!used) return { gains: [1, 1, 1], exposure: 1, method: 'gray' };
  const lum = new Float32Array(n);
  const vals: number[] = [];
  for (let i = 0; i < n; i++) {
    lum[i] = 0.2126 * LIN_LUT[d[i * 4]] + 0.7152 * LIN_LUT[d[i * 4 + 1]] + 0.0722 * LIN_LUT[d[i * 4 + 2]];
    if (use[i]) vals.push(lum[i]);
  }
  const sorted = Float32Array.from(vals).sort();
  const p85 = sorted[Math.floor(used * 0.85)], p98 = sorted[Math.floor(used * 0.98)] || 1e-3;
  // Bright, low-saturation, unclipped pixels: probably white paper or white areas.
  let r = 0, g = 0, b = 0, count = 0;
  for (let i = 0; i < n; i++) {
    if (!use[i] || lum[i] < p85) continue;
    const R = d[i * 4], G = d[i * 4 + 1], B = d[i * 4 + 2];
    const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
    if (mx > 250 || !mx || (mx - mn) / mx > 0.42) continue; // warm bulbs make paper quite orange
    r += LIN_LUT[R]; g += LIN_LUT[G]; b += LIN_LUT[B]; count++;
  }
  let method: WbEstimate['method'] = 'white';
  let strength = 1;
  if (count < used * 0.01) {
    // Grey world: the average colour of the whole picture, applied at half strength because
    // colourful pictures aren't grey on average.
    r = g = b = 0;
    for (let i = 0; i < n; i++) if (use[i]) { r += LIN_LUT[d[i * 4]]; g += LIN_LUT[d[i * 4 + 1]]; b += LIN_LUT[d[i * 4 + 2]]; }
    method = 'gray';
    strength = opts.grayStrength ?? 0.5;
  }
  const avg = (r + g + b) / 3 || 1;
  const raw: [number, number, number] = [avg / (r || 1), avg / (g || 1), avg / (b || 1)];
  const gains = raw.map((k) => Math.max(0.6, Math.min(1.8, 1 + (k - 1) * strength))) as [number, number, number];
  // Brighten dim photos so the paper reads as white (never darken, cap at ~1.3 stops).
  const exposure = Math.max(1, Math.min(2.5, 0.85 / p98));
  return { gains, exposure, method };
}

/** Apply auto correction (if on) plus manual warmth / tint / exposure. */
export function applyColor(src: Img, adj: ColorAdjust, est: WbEstimate | null): Img {
  let gr = 1, gg = 1, gb = 1, ex = Math.pow(2, adj.exposure);
  if (adj.auto && est) {
    [gr, gg, gb] = est.gains;
    ex *= est.exposure;
  }
  gr *= 1 + 0.18 * adj.warmth;
  gb *= 1 - 0.18 * adj.warmth;
  gg *= 1 - 0.12 * adj.tint;
  const lut = (k: number) => {
    const t = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) {
      const x = LIN_LUT[v] * k;
      // Soft shoulder so boosted highlights roll off instead of clipping flat.
      t[v] = linearToSrgb(x > 0.85 ? 0.85 + (1 - Math.exp(-(x - 0.85) * 6.7)) * 0.15 : x);
    }
    return t;
  };
  const R = lut(gr * ex), G = lut(gg * ex), B = lut(gb * ex);
  const d = src.data, out = new Uint8ClampedArray(d.length);
  for (let i = 0; i < d.length; i += 4) {
    out[i] = R[d[i]]; out[i + 1] = G[d[i + 1]]; out[i + 2] = B[d[i + 2]]; out[i + 3] = d[i + 3];
  }
  return { data: out, width: src.width, height: src.height };
}

export function isNeutral(adj: ColorAdjust | undefined): boolean {
  return !adj || (!adj.auto && !adj.warmth && !adj.tint && !adj.exposure);
}
