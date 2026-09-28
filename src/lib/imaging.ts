// Pixel-level helpers: loading, straightening (perspective warp), encoding.
import { applyH, homography, invert3, multiply3, rotationAbout, type Mat3 } from './geometry';
import type { Pt, Quad } from './types';

export type Img = { data: Uint8ClampedArray; width: number; height: number };

/** iOS canvases are limited to ~16.7 MP, so we keep working images modest. */
export const MAX_SOURCE_SIDE = 2400;

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export async function loadImageElement(src: Blob | string): Promise<HTMLImageElement> {
  const url = typeof src === 'string' ? src : URL.createObjectURL(src);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  try {
    await img.decode();
  } catch {
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('Could not read that image'));
    });
  }
  return img;
}

/** Decode a photo (EXIF orientation respected by the browser) and downscale it. */
export async function loadPhoto(file: Blob, maxSide = MAX_SOURCE_SIDE): Promise<HTMLCanvasElement> {
  const img = await loadImageElement(file);
  const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = makeCanvas(img.naturalWidth * s, img.naturalHeight * s);
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  if (typeof file !== 'string') URL.revokeObjectURL(img.src);
  return c;
}

export function canvasToImg(c: HTMLCanvasElement): Img {
  const d = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height);
  return { data: d.data, width: d.width, height: d.height };
}

export function imgToCanvas(img: Img): HTMLCanvasElement {
  const c = makeCanvas(img.width, img.height);
  c.getContext('2d')!.putImageData(new ImageData(img.data as unknown as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
  return c;
}

export function toBlob(c: HTMLCanvasElement, type = 'image/jpeg', quality = 0.9): Promise<Blob> {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), type, quality));
}

export function downscale(img: Img, maxSide: number): { img: Img; scale: number } {
  const s = Math.min(1, maxSide / Math.max(img.width, img.height));
  if (s === 1) return { img, scale: 1 };
  const c = imgToCanvas(img);
  const d = makeCanvas(img.width * s, img.height * s);
  const ctx = d.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(c, 0, 0, d.width, d.height);
  return { img: canvasToImg(d), scale: d.width / img.width };
}

/** Rotate a canvas by a multiple of 90°. */
export function rotate90(c: HTMLCanvasElement, turns: number): HTMLCanvasElement {
  const t = ((turns % 4) + 4) % 4;
  if (!t) return c;
  const out = t % 2 ? makeCanvas(c.height, c.width) : makeCanvas(c.width, c.height);
  const ctx = out.getContext('2d')!;
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((t * Math.PI) / 2);
  ctx.drawImage(c, -c.width / 2, -c.height / 2);
  return out;
}

export interface WarpSpec {
  /** Corners in the source image (TL, TR, BR, BL). */
  quad: Quad;
  /** Real-world size of that quad. Any unit — output is `pxPerUnit` pixels per unit. */
  w: number;
  h: number;
  /** Output extent in the same units, relative to the quad's top-left. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  pxPerUnit: number;
  /** Extra rotation of the result about the quad's centre (degrees). */
  fineRotation?: number;
}

/** Maps output units -> source pixels. */
export function unitToSource(spec: WarpSpec): Mat3 {
  const dst: Pt[] = [
    { x: 0, y: 0 },
    { x: spec.w, y: 0 },
    { x: spec.w, y: spec.h },
    { x: 0, y: spec.h },
  ];
  let H = homography(dst, spec.quad);
  if (spec.fineRotation) H = multiply3(H, rotationAbout(-spec.fineRotation, spec.w / 2, spec.h / 2));
  return H;
}

/**
 * Perspective-correct a region of `src`. Uses inverse mapping with bilinear sampling;
 * pixels that fall outside the source become transparent.
 */
export function warp(src: Img, spec: WarpSpec): Img {
  const H = unitToSource(spec);
  const W = Math.max(1, Math.round((spec.x1 - spec.x0) * spec.pxPerUnit));
  const Hh = Math.max(1, Math.round((spec.y1 - spec.y0) * spec.pxPerUnit));
  const out = new Uint8ClampedArray(W * Hh * 4);
  const sd = src.data;
  const sw = src.width, sh = src.height;
  const inv = 1 / spec.pxPerUnit;
  for (let j = 0; j < Hh; j++) {
    const uy = spec.y0 + (j + 0.5) * inv;
    for (let i = 0; i < W; i++) {
      const ux = spec.x0 + (i + 0.5) * inv;
      const w = H[6] * ux + H[7] * uy + H[8];
      const sx = (H[0] * ux + H[1] * uy + H[2]) / w - 0.5;
      const sy = (H[3] * ux + H[4] * uy + H[5]) / w - 0.5;
      if (sx < -0.5 || sy < -0.5 || sx > sw - 0.5 || sy > sh - 0.5 || w <= 0) continue;
      const x0 = Math.max(0, Math.floor(sx)), y0 = Math.max(0, Math.floor(sy));
      const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
      const fx = Math.min(1, Math.max(0, sx - x0)), fy = Math.min(1, Math.max(0, sy - y0));
      const a = (y0 * sw + x0) * 4, b = (y0 * sw + x1) * 4, c = (y1 * sw + x0) * 4, d = (y1 * sw + x1) * 4;
      const o = (j * W + i) * 4;
      for (let k = 0; k < 4; k++) {
        const top = sd[a + k] + (sd[b + k] - sd[a + k]) * fx;
        const bot = sd[c + k] + (sd[d + k] - sd[c + k]) * fx;
        out[o + k] = top + (bot - top) * fy;
      }
    }
  }
  return { data: out, width: W, height: Hh };
}

/**
 * For a wall: how far beyond the pinned rectangle does the photo reach?
 * Maps the photo's border into wall units and clamps to a sane range.
 */
export function visibleExtent(srcW: number, srcH: number, quad: Quad, w: number, h: number, maxFactor = 3) {
  const toUnit = invert3(homography([{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }], quad));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const steps = 24;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    for (const p of [
      { x: t * srcW, y: 0 },
      { x: t * srcW, y: srcH },
      { x: 0, y: t * srcH },
      { x: srcW, y: t * srcH },
    ]) {
      const q = applyH(toUnit, p.x, p.y);
      // A point behind the camera's horizon maps to a negative w; skip it.
      const wv = toUnit[6] * p.x + toUnit[7] * p.y + toUnit[8];
      if (wv <= 0 || !isFinite(q.x) || !isFinite(q.y)) continue;
      x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y);
      x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y);
    }
  }
  return {
    x0: Math.max(x0, -w * maxFactor, -w * 3),
    y0: Math.max(y0, -h * maxFactor),
    x1: Math.min(x1, w * (1 + maxFactor)),
    y1: Math.min(y1, h * (1 + maxFactor)),
  };
}

/** Choose a pixel density so the output stays under `maxSide` pixels. */
export function pxPerUnitFor(extentW: number, extentH: number, maxSide: number) {
  return maxSide / Math.max(extentW, extentH);
}

// ---- Colour helpers -------------------------------------------------------

export function srgbToLinear(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(v: number): number {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}

export const LIN_LUT = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) t[i] = srgbToLinear(i);
  return t;
})();

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max ? d / max : 0, max];
}
