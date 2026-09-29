import type { Pt } from './types';

/** 3x3 homography stored row-major as 9 numbers. */
export type Mat3 = number[];

/** Solve Ax=b (n x n) with Gaussian elimination and partial pivoting. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c];
    if (Math.abs(d) < 1e-12) throw new Error('Singular matrix');
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** Homography mapping src[i] -> dst[i] for four point pairs. */
export function homography(src: Pt[], dst: Pt[]): Mat3 {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solve(A, b);
  return [...h, 1];
}

export function applyH(H: Mat3, x: number, y: number): Pt {
  const w = H[6] * x + H[7] * y + H[8];
  return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
}

export function invert3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) throw new Error('Singular');
  const inv = [
    A, -(b * i - c * h), b * f - c * e,
    B, a * i - c * g, -(a * f - c * d),
    C, -(a * h - b * g), a * e - b * d,
  ];
  return inv.map((v) => v / det);
}

export function multiply3(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
}

export function rotationAbout(deg: number, cx: number, cy: number): Mat3 {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  // translate(c) * rotate * translate(-c)
  return [c, -s, cx - c * cx + s * cy, s, c, cy - s * cx - c * cy, 0, 0, 1];
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function polygonArea(poly: Pt[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
  return Math.abs(a / 2);
}

export function polygonPerimeter(poly: Pt[]): number {
  let p = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) p += dist(poly[i], poly[j]);
  return p;
}

export function bbox(pts: Pt[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Ramer–Douglas–Peucker simplification for a closed polygon. */
export function simplify(poly: Pt[], eps: number): Pt[] {
  if (poly.length < 4) return poly;
  // Split the ring at its two farthest-apart points so both halves are open polylines.
  let far = 0, best = -1;
  for (let i = 1; i < poly.length; i++) {
    const d = dist(poly[0], poly[i]);
    if (d > best) { best = d; far = i; }
  }
  const a = rdp(poly.slice(0, far + 1), eps);
  const b = rdp([...poly.slice(far), poly[0]], eps);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

function rdp(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts;
  const a = pts[0], b = pts[pts.length - 1];
  let idx = -1, dmax = 0;
  const len = dist(a, b) || 1e-9;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const d = Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len;
    if (d > dmax) { dmax = d; idx = i; }
  }
  if (dmax <= eps) return [a, b];
  const left = rdp(pts.slice(0, idx + 1), eps);
  const right = rdp(pts.slice(idx), eps);
  return [...left.slice(0, -1), ...right];
}

export function rectPoly(x: number, y: number, w: number, h: number): Pt[] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

export function ellipsePoly(x: number, y: number, w: number, h: number, n = 64): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    out.push({ x: x + w / 2 + (Math.cos(t) * w) / 2, y: y + h / 2 + (Math.sin(t) * h) / 2 });
  }
  return out;
}

export interface Rect { x: number; y: number; w: number; h: number }

export function rectsOverlap(a: Rect, b: Rect, margin = 0): boolean {
  return a.x < b.x + b.w + margin && b.x < a.x + a.w + margin && a.y < b.y + b.h + margin && b.y < a.y + a.h + margin;
}

/** Axis-aligned bounding size of a w×h rectangle rotated by deg. */
export function rotatedSize(w: number, h: number, deg: number) {
  const t = (deg * Math.PI) / 180;
  const c = Math.abs(Math.cos(t));
  const s = Math.abs(Math.sin(t));
  return { w: w * c + h * s, h: w * s + h * c };
}

export function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

/** Order four arbitrary points as TL, TR, BR, BL. */
export function orderQuad(pts: Pt[]): [Pt, Pt, Pt, Pt] {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const sorted = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  // atan2 order starting from -PI: TL(-3π/4), TR(-π/4), BR(π/4), BL(3π/4)
  return [sorted[0], sorted[1], sorted[2], sorted[3]];
}

/**
 * Least-squares homography from N ≥ 4 point pairs (normalised DLT with h33 = 1).
 * With exactly four pairs this equals `homography`; more pairs average out tapping error.
 */
export function homographyLSQ(src: Pt[], dst: Pt[]): Mat3 {
  if (src.length === 4) return homography(src, dst);
  const norm = (pts: Pt[]) => {
    const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
    const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
    const d = pts.reduce((a, p) => a + Math.hypot(p.x - cx, p.y - cy), 0) / pts.length || 1;
    const s = Math.SQRT2 / d;
    return { T: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1] as Mat3, pts: pts.map((p) => ({ x: (p.x - cx) * s, y: (p.y - cy) * s })) };
  };
  const a = norm(src), b = norm(dst);
  // Normal equations AᵀA h = Aᵀb for the 8 unknowns.
  const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const Atb = new Array(8).fill(0);
  const add = (row: number[], rhs: number) => {
    for (let i = 0; i < 8; i++) {
      Atb[i] += row[i] * rhs;
      for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j];
    }
  };
  for (let i = 0; i < a.pts.length; i++) {
    const { x, y } = a.pts[i];
    const { x: u, y: v } = b.pts[i];
    add([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
    add([0, 0, 0, x, y, 1, -v * x, -v * y], v);
  }
  const h = solveLinear(AtA, Atb);
  const Hn = [...h, 1];
  // Undo the normalisation: H = T_b⁻¹ · Hn · T_a
  return multiply3(multiply3(invert3(b.T), Hn), a.T);
}

function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c];
    if (Math.abs(d) < 1e-12) throw new Error('Points are too close together or in a line');
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** Mean distance (in dst units) between mapped src points and dst points. */
export function reprojectionError(H: Mat3, src: Pt[], dst: Pt[]): number {
  let e = 0;
  for (let i = 0; i < src.length; i++) e += dist(applyH(H, src[i].x, src[i].y), dst[i]);
  return e / Math.max(1, src.length);
}
