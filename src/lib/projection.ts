// Mapping between wall inches, image pixels and the screen.
//
// Every view is "wall inches → image pixels" (a homography H) followed by the pan/zoom of the
// canvas. In straightened mode H is a plain scale; in photo mode H is the perspective of the
// original photo, so frames shrink and skew as they move across the wall — just like reality.
import { applyH, homography, invert3, multiply3, type Mat3 } from './geometry';
import type { Pt, Wall } from './types';

export function scaleMat(k: number): Mat3 {
  return [k, 0, 0, 0, k, 0, 0, 0, 1];
}

export function translateMat(x: number, y: number): Mat3 {
  return [1, 0, x, 0, 1, y, 0, 0, 1];
}

export function viewMat(v: { s: number; tx: number; ty: number }): Mat3 {
  return [v.s, 0, v.tx, 0, v.s, v.ty, 0, 0, 1];
}

/** Wall inches → straightened-image pixels. */
export function wallToStraight(w: Wall, imgW: number): Mat3 {
  const ppi = imgW / (w.x1 - w.x0);
  return [ppi, 0, -w.x0 * ppi, 0, ppi, -w.y0 * ppi, 0, 0, 1];
}

/** Wall inches → original-photo pixels. */
export function wallToSource(w: Wall): Mat3 {
  return homography(
    [{ x: 0, y: 0 }, { x: w.refW, y: 0 }, { x: w.refW, y: w.refH }, { x: 0, y: w.refH }],
    w.quad,
  );
}

/** CSS matrix3d() for a 2D homography (row-major 3×3). Use with transform-origin: 0 0. */
export function cssMatrix(m: Mat3): string {
  const n = m[8] || 1;
  const [a, b, c, d, e, f, g, h, i] = m.map((v) => v / n);
  return `matrix3d(${a},${d},0,${g},${b},${e},0,${h},0,0,1,0,${c},${f},0,${i})`;
}

export function project(m: Mat3, p: Pt): Pt {
  return applyH(m, p.x, p.y);
}

/** Screen pixels per inch around a wall point (average of x and y). */
export function localScale(m: Mat3, p: Pt): number {
  const a = applyH(m, p.x, p.y);
  const b = applyH(m, p.x + 1, p.y);
  const c = applyH(m, p.x, p.y + 1);
  return (Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(c.x - a.x, c.y - a.y)) / 2;
}

export { invert3, multiply3 };
