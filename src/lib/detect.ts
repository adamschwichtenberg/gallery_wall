// Automatic detection heuristics: frame cut-out, corners, openings and colour tags.
// All of these are best-effort starting points — every result is editable in the UI.
import { applyH, bbox, homography, invert3, polygonArea, polygonPerimeter, simplify } from './geometry';
import { downscale, LIN_LUT, rgbToHex, rgbToHsv, type Img } from './imaging';
import type { FrameShape, Opening, Pt, Quad } from './types';

// ---- Lab conversion --------------------------------------------------------

function labOf(r: number, g: number, b: number, out: Float32Array, o: number) {
  const R = LIN_LUT[r], G = LIN_LUT[g], B = LIN_LUT[b];
  let x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  let y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  let z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = f(x); y = f(y); z = f(z);
  out[o] = 116 * y - 16;
  out[o + 1] = 500 * (x - y);
  out[o + 2] = 200 * (y - z);
}

function toLab(img: Img): Float32Array {
  const n = img.width * img.height;
  const lab = new Float32Array(n * 3);
  const d = img.data;
  for (let i = 0; i < n; i++) labOf(d[i * 4], d[i * 4 + 1], d[i * 4 + 2], lab, i * 3);
  return lab;
}

// ---- A light Gaussian-mixture model (k-means seeded) -----------------------

interface Mixture { means: Float32Array; vars: Float32Array; weights: Float32Array; k: number }

function kmeans(samples: Float32Array, dim: number, k: number, iters = 8): { centers: Float32Array; assign: Int32Array } {
  const n = samples.length / dim;
  const centers = new Float32Array(k * dim);
  const assign = new Int32Array(n);
  if (!n) return { centers, assign };
  // k-means++ style seeding (deterministic: farthest point).
  centers.set(samples.subarray(0, dim), 0);
  const dmin = new Float32Array(n).fill(Infinity);
  for (let c = 1; c < k; c++) {
    let far = 0, best = -1;
    for (let i = 0; i < n; i++) {
      let d = 0;
      for (let t = 0; t < dim; t++) { const v = samples[i * dim + t] - centers[(c - 1) * dim + t]; d += v * v; }
      if (d < dmin[i]) dmin[i] = d;
      if (dmin[i] > best) { best = dmin[i]; far = i; }
    }
    centers.set(samples.subarray(far * dim, far * dim + dim), c * dim);
  }
  const sums = new Float64Array(k * dim);
  const counts = new Int32Array(k);
  for (let it = 0; it < iters; it++) {
    sums.fill(0); counts.fill(0);
    for (let i = 0; i < n; i++) {
      let bi = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        let d = 0;
        for (let t = 0; t < dim; t++) { const v = samples[i * dim + t] - centers[c * dim + t]; d += v * v; }
        if (d < bd) { bd = d; bi = c; }
      }
      assign[i] = bi;
      counts[bi]++;
      for (let t = 0; t < dim; t++) sums[bi * dim + t] += samples[i * dim + t];
    }
    for (let c = 0; c < k; c++) if (counts[c]) for (let t = 0; t < dim; t++) centers[c * dim + t] = sums[c * dim + t] / counts[c];
  }
  return { centers, assign };
}

function fitMixture(samples: Float32Array, k: number): Mixture {
  const n = samples.length / 3;
  const { centers, assign } = kmeans(samples, 3, Math.min(k, Math.max(1, n)));
  const kk = centers.length / 3;
  const vars = new Float32Array(kk);
  const weights = new Float32Array(kk);
  for (let i = 0; i < n; i++) {
    const c = assign[i];
    let d = 0;
    for (let t = 0; t < 3; t++) { const v = samples[i * 3 + t] - centers[c * 3 + t]; d += v * v; }
    vars[c] += d / 3;
    weights[c]++;
  }
  for (let c = 0; c < kk; c++) {
    vars[c] = Math.max(12, weights[c] ? vars[c] / weights[c] : 50);
    weights[c] = Math.max(1e-4, weights[c] / Math.max(1, n));
  }
  return { means: centers, vars, weights, k: kk };
}

function logLik(m: Mixture, lab: Float32Array, o: number): number {
  let best = -Infinity;
  for (let c = 0; c < m.k; c++) {
    let d = 0;
    for (let t = 0; t < 3; t++) { const v = lab[o + t] - m.means[c * 3 + t]; d += v * v; }
    const ll = Math.log(m.weights[c]) - 1.5 * Math.log(m.vars[c]) - d / (2 * m.vars[c]);
    if (ll > best) best = ll;
  }
  return best;
}

function sampleBy(lab: Float32Array, pick: (i: number) => boolean, n: number, max = 6000): Float32Array {
  const idx: number[] = [];
  for (let i = 0; i < n; i++) if (pick(i)) idx.push(i);
  const step = Math.max(1, Math.floor(idx.length / max));
  const out = new Float32Array(Math.ceil(idx.length / step) * 3);
  let j = 0;
  for (let i = 0; i < idx.length; i += step, j++) out.set(lab.subarray(idx[i] * 3, idx[i] * 3 + 3), j * 3);
  return out.subarray(0, j * 3);
}

// ---- Binary mask utilities --------------------------------------------------

type Mask = Uint8Array;

function morph(m: Mask, w: number, h: number, r: number, dilate: boolean): Mask {
  // Separable square structuring element.
  const tmp = new Uint8Array(m.length);
  const out = new Uint8Array(m.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = dilate ? 0 : 1;
      for (let k = -r; k <= r; k++) {
        const xx = Math.min(w - 1, Math.max(0, x + k));
        const s = m[y * w + xx];
        if (dilate ? s : !s) { v = dilate ? 1 : 0; break; }
      }
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = dilate ? 0 : 1;
      for (let k = -r; k <= r; k++) {
        const yy = Math.min(h - 1, Math.max(0, y + k));
        const s = tmp[yy * w + x];
        if (dilate ? s : !s) { v = dilate ? 1 : 0; break; }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/** Label 4-connected components; returns labels and per-label pixel counts. */
function components(m: Mask, w: number, h: number) {
  const labels = new Int32Array(m.length);
  const sizes: number[] = [0];
  const stack: number[] = [];
  let next = 1;
  for (let i = 0; i < m.length; i++) {
    if (!m[i] || labels[i]) continue;
    let count = 0;
    labels[i] = next;
    stack.push(i);
    while (stack.length) {
      const p = stack.pop()!;
      count++;
      const x = p % w, y = (p / w) | 0;
      if (x > 0 && m[p - 1] && !labels[p - 1]) { labels[p - 1] = next; stack.push(p - 1); }
      if (x < w - 1 && m[p + 1] && !labels[p + 1]) { labels[p + 1] = next; stack.push(p + 1); }
      if (y > 0 && m[p - w] && !labels[p - w]) { labels[p - w] = next; stack.push(p - w); }
      if (y < h - 1 && m[p + w] && !labels[p + w]) { labels[p + w] = next; stack.push(p + w); }
    }
    sizes.push(count);
    next++;
  }
  return { labels, sizes };
}

function fillHoles(m: Mask, w: number, h: number): Mask {
  const inv = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) inv[i] = m[i] ? 0 : 1;
  const { labels } = components(inv, w, h);
  const outside = new Set<number>();
  for (let x = 0; x < w; x++) { outside.add(labels[x]); outside.add(labels[(h - 1) * w + x]); }
  for (let y = 0; y < h; y++) { outside.add(labels[y * w]); outside.add(labels[y * w + w - 1]); }
  const out = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) out[i] = m[i] || !outside.has(labels[i]) ? 1 : 0;
  return out;
}

/** Moore-neighbour trace of the outer boundary of the component containing `start`. */
function traceContour(m: Mask, w: number, h: number): Pt[] {
  let start = -1;
  for (let i = 0; i < m.length; i++) if (m[i]) { start = i; break; }
  if (start < 0) return [];
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && m[y * w + x] === 1;
  const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const sx = start % w, sy = (start / w) | 0;
  const pts: Pt[] = [{ x: sx, y: sy }];
  let cx = sx, cy = sy, dir = 7;
  for (let guard = 0; guard < w * h * 2; guard++) {
    let found = false;
    for (let k = 0; k < 8; k++) {
      const d = (dir + 6 + k) % 8; // start looking from "back-left"
      const nx = cx + dirs[d][0], ny = cy + dirs[d][1];
      if (at(nx, ny)) {
        cx = nx; cy = ny; dir = d; found = true;
        break;
      }
    }
    if (!found || (cx === sx && cy === sy)) break;
    pts.push({ x: cx, y: cy });
  }
  return pts;
}

// ---- Frame segmentation ------------------------------------------------------

export interface FrameDetection {
  quad: Quad; // in source pixels
  contour: Pt[]; // in source pixels
}

/**
 * Separate the frame from the surface it is lying on. Background colours are learnt from the
 * photo's border, foreground from its centre, then refined a few times (a simplified GrabCut).
 */
export function detectFrame(src: Img): FrameDetection | null {
  const { img, scale } = downscale(src, 360);
  const w = img.width, h = img.height, n = w * h;
  const lab = toLab(img);
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.04));
  const isBorder = (i: number) => {
    const x = i % w, y = (i / w) | 0;
    return x < band || y < band || x >= w - band || y >= h - band;
  };
  const isCentre = (i: number) => {
    const x = i % w, y = (i / w) | 0;
    return x > w * 0.3 && x < w * 0.7 && y > h * 0.3 && y < h * 0.7;
  };
  let bg = fitMixture(sampleBy(lab, isBorder, n), 6);
  let fg = fitMixture(sampleBy(lab, isCentre, n), 6);
  let mask: Mask = new Uint8Array(n);
  for (let iter = 0; iter < 4; iter++) {
    for (let i = 0; i < n; i++) mask[i] = !isBorder(i) && logLik(fg, lab, i * 3) > logLik(bg, lab, i * 3) ? 1 : 0;
    mask = morph(morph(mask, w, h, 1, false), w, h, 1, true); // open: drop speckle
    mask = morph(morph(mask, w, h, 2, true), w, h, 2, false); // close: bridge small gaps
    // Keep the component that best covers the centre of the photo.
    const { labels, sizes } = components(mask, w, h);
    const score = new Float64Array(sizes.length);
    for (let i = 0; i < n; i++) {
      const l = labels[i];
      if (!l) continue;
      const x = i % w, y = (i / w) | 0;
      const dx = (x - w / 2) / w, dy = (y - h / 2) / h;
      score[l] += Math.exp(-(dx * dx + dy * dy) * 8);
    }
    let best = 0;
    for (let l = 1; l < sizes.length; l++) if (score[l] > score[best]) best = l;
    if (!best) return null;
    for (let i = 0; i < n; i++) mask[i] = labels[i] === best ? 1 : 0;
    mask = fillHoles(mask, w, h);
    if (iter < 3) {
      fg = fitMixture(sampleBy(lab, (i) => mask[i] === 1, n), 6);
      bg = fitMixture(sampleBy(lab, (i) => mask[i] === 0, n), 6);
    }
  }
  let area = 0;
  for (let i = 0; i < n; i++) area += mask[i];
  if (area < n * 0.01) return null;
  const contour = traceContour(mask, w, h).map((p) => ({ x: (p.x + 0.5) / scale, y: (p.y + 0.5) / scale }));
  return { quad: quadFromContour(contour), contour };
}

/** Fit a quadrilateral: the four contour points that are extreme along the diagonals. */
export function quadFromContour(contour: Pt[]): Quad {
  let tl = contour[0], tr = contour[0], br = contour[0], bl = contour[0];
  for (const p of contour) {
    if (p.x + p.y < tl.x + tl.y) tl = p;
    if (p.x + p.y > br.x + br.y) br = p;
    if (p.x - p.y > tr.x - tr.y) tr = p;
    if (p.y - p.x > bl.y - bl.x) bl = p;
  }
  return [{ ...tl }, { ...tr }, { ...br }, { ...bl }];
}

/** Map a source-pixel contour into frame inches (relative to the frame's top-left) and simplify. */
export function contourToOutline(contour: Pt[], quad: Quad, wIn: number, hIn: number, fineRotation = 0): Pt[] {
  const H = homography(quad, [{ x: 0, y: 0 }, { x: wIn, y: 0 }, { x: wIn, y: hIn }, { x: 0, y: hIn }]);
  let pts = contour.map((p) => applyH(H, p.x, p.y));
  if (fineRotation) {
    const t = (fineRotation * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
    const cx = wIn / 2, cy = hIn / 2;
    pts = pts.map((p) => ({ x: cx + (p.x - cx) * c - (p.y - cy) * s, y: cy + (p.x - cx) * s + (p.y - cy) * c }));
  }
  const eps = Math.max(wIn, hIn) * 0.0055;
  return simplify(pts, eps).map((p) => ({ x: round3(p.x), y: round3(p.y) }));
}

function round3(v: number) {
  return Math.round(v * 1000) / 1000;
}

export function inverseQuadMap(quad: Quad, wIn: number, hIn: number) {
  return invert3(homography(quad, [{ x: 0, y: 0 }, { x: wIn, y: 0 }, { x: wIn, y: hIn }, { x: 0, y: hIn }]));
}

// ---- Openings ----------------------------------------------------------------

/**
 * Find picture openings inside a straightened frame image.
 * `img` covers the frame's nominal rectangle at `ppi` pixels per inch, offset by pad.
 */
export function detectOpenings(img: Img, ppi: number, padX: number, padY: number, wIn: number, hIn: number): { openings: Opening[]; matted: boolean } {
  const { img: small, scale } = downscale(img, 420);
  const p = ppi * scale;
  const W = small.width, H = small.height;
  const lab = toLab(small);
  const px = (xIn: number) => Math.round((xIn + padX) * p);
  const py = (yIn: number) => Math.round((yIn + padY) * p);
  // Interior: the frame rect inset by 6% (skip most of the molding).
  const ix0 = px(wIn * 0.06), ix1 = px(wIn * 0.94), iy0 = py(hIn * 0.06), iy1 = py(hIn * 0.94);
  const at = (x: number, y: number) => (Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))) * 3;

  // 1) Look for a mat: a large, low-variance, light region.
  const samples: number[] = [];
  for (let y = iy0; y < iy1; y += 2) for (let x = ix0; x < ix1; x += 2) {
    const o = at(x, y);
    samples.push(lab[o], lab[o + 1], lab[o + 2]);
  }
  const s = new Float32Array(samples);
  const { centers, assign } = kmeans(s, 3, 5);
  const counts = new Array(centers.length / 3).fill(0);
  for (const a of assign) counts[a]++;
  let matC = -1;
  const total = assign.length;
  for (let c = 0; c < counts.length; c++) {
    const L = centers[c * 3];
    const chroma = Math.hypot(centers[c * 3 + 1], centers[c * 3 + 2]);
    if (counts[c] / total > 0.22 && L > 55 && chroma < 25 && (matC < 0 || counts[c] > counts[matC])) matC = c;
  }

  if (matC >= 0) {
    const mL = centers[matC * 3], ma = centers[matC * 3 + 1], mb = centers[matC * 3 + 2];
    const nonMat = (x: number, y: number) => {
      const o = at(x, y);
      const d = Math.hypot(lab[o] - mL, (lab[o + 1] - ma) * 1.5, (lab[o + 2] - mb) * 1.5);
      return d > 14;
    };
    // Where does the mat begin? Scan inward from each side along several lines.
    const colFrac = new Float32Array(W), rowFrac = new Float32Array(H);
    for (let x = ix0; x < ix1; x++) {
      let c = 0;
      for (let y = iy0; y < iy1; y++) c += nonMat(x, y) ? 1 : 0;
      colFrac[x] = c / (iy1 - iy0);
    }
    for (let y = iy0; y < iy1; y++) {
      let c = 0;
      for (let x = ix0; x < ix1; x++) c += nonMat(x, y) ? 1 : 0;
      rowFrac[y] = c / (ix1 - ix0);
    }
    const xb = dropSlivers(bands(colFrac, ix0, ix1, 0.06, p * 0.4), p);
    const yb = dropSlivers(bands(rowFrac, iy0, iy1, 0.06, p * 0.4), p);
    const openings: Opening[] = [];
    for (const [ya, yz] of yb) for (const [xa, xz] of xb) {
      let c = 0;
      for (let y = ya; y < yz; y++) for (let x = xa; x < xz; x++) c += nonMat(x, y) ? 1 : 0;
      const frac = c / Math.max(1, (yz - ya) * (xz - xa));
      if (frac < 0.12) continue;
      openings.push({
        id: `o${openings.length + 1}`,
        x: xa / p - padX, y: ya / p - padY,
        w: (xz - xa) / p, h: (yz - ya) / p,
        shape: 'rect',
      });
    }
    // If the mat spans the whole interior with nothing notable, fall through.
    if (openings.length) return { openings: equalise(openings), matted: true };
  }

  // 2) No mat: the opening is inside the molding. Find where the molding colour ends.
  const inset = moldingInsets(lab, W, H, px, py, wIn, hIn, p);
  return {
    openings: [{ id: 'o1', x: inset.l, y: inset.t, w: wIn - inset.l - inset.r, h: hIn - inset.t - inset.b, shape: 'rect' }],
    matted: false,
  };
}

/** Contiguous runs where profile > thr, merged across gaps shorter than `minGap`. */
function bands(profile: Float32Array, a: number, z: number, thr: number, minGap: number): [number, number][] {
  const runs: [number, number][] = [];
  let start = -1;
  for (let i = a; i <= z; i++) {
    const on = i < z && profile[i] > thr;
    if (on && start < 0) start = i;
    if (!on && start >= 0) { runs.push([start, i]); start = -1; }
  }
  const merged: [number, number][] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] < minGap) last[1] = r[1];
    else merged.push([...r]);
  }
  return merged.filter(([s, e]) => e - s > minGap);
}

/** Molding edges show up as thin bands next to the real openings; drop them. */
function dropSlivers(b: [number, number][], ppi: number): [number, number][] {
  if (b.length < 2) return b;
  const widths = b.map(([s, e]) => e - s).sort((x, y) => x - y);
  const med = widths[widths.length >> 1];
  return b.filter(([s, e]) => e - s >= Math.min(med * 0.45, ppi * 1.25));
}

/** Make near-identical openings exactly the same size (typical of multi-opening mats). */
function equalise(ops: Opening[]): Opening[] {
  if (ops.length < 2) return ops;
  const med = (vals: number[]) => [...vals].sort((a, b) => a - b)[vals.length >> 1];
  const mw = med(ops.map((o) => o.w)), mh = med(ops.map((o) => o.h));
  return ops.map((o) => {
    if (Math.abs(o.w - mw) / mw < 0.15 && Math.abs(o.h - mh) / mh < 0.15) {
      const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
      return { ...o, w: q8(mw), h: q8(mh), x: q8(cx - mw / 2), y: q8(cy - mh / 2) };
    }
    return { ...o, x: q8(o.x), y: q8(o.y), w: q8(o.w), h: q8(o.h) };
  });
}

function q8(v: number) {
  return Math.round(v * 8) / 8;
}

function moldingInsets(
  lab: Float32Array, W: number, H: number,
  px: (x: number) => number, py: (y: number) => number,
  wIn: number, hIn: number, p: number,
) {
  const at = (x: number, y: number) => (Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))) * 3;
  // Molding colour: median of a thin band just inside the outer edge.
  const ring: number[][] = [];
  for (let t = 0.02; t < 0.06; t += 0.01) {
    for (let u = 0.1; u < 0.9; u += 0.05) {
      for (const [x, y] of [[u * wIn, t * hIn], [u * wIn, (1 - t) * hIn], [t * wIn, u * hIn], [(1 - t) * wIn, u * hIn]]) {
        const o = at(px(x), py(y));
        ring.push([lab[o], lab[o + 1], lab[o + 2]]);
      }
    }
  }
  const med = (k: number) => ring.map((r) => r[k]).sort((a, b) => a - b)[ring.length >> 1];
  const mol = [med(0), med(1), med(2)];
  const isMolding = (x: number, y: number) => {
    const o = at(x, y);
    return Math.hypot(lab[o] - mol[0], lab[o + 1] - mol[1], lab[o + 2] - mol[2]) < 22;
  };
  const scan = (fromEdge: (d: number, u: number) => [number, number], maxIn: number) => {
    const found: number[] = [];
    for (let u = 0.3; u <= 0.7; u += 0.05) {
      let lastMolding = 0;
      const steps = Math.round(maxIn * p);
      let miss = 0;
      for (let s = 0; s < steps; s++) {
        const [x, y] = fromEdge(s / p, u);
        if (isMolding(px(x), py(y))) { lastMolding = s; miss = 0; } else if (++miss > p * 0.35) break;
      }
      found.push(lastMolding / p);
    }
    found.sort((a, b) => a - b);
    return q8(Math.max(0.25, found[found.length >> 1] + 1 / p));
  };
  const maxX = wIn * 0.35, maxY = hIn * 0.35;
  // Picture colours close to the molding can only make a side look *wider*, and moldings are
  // nearly always symmetric, so trust the narrower side of each pair.
  const lr = Math.min(scan((d, u) => [d, u * hIn], maxX), scan((d, u) => [wIn - d, u * hIn], maxX));
  const tb = Math.min(scan((d, u) => [u * wIn, d], maxY), scan((d, u) => [u * wIn, hIn - d], maxY));
  return { l: lr, r: lr, t: tb, b: tb };
}

// ---- Colour tags ---------------------------------------------------------------

export function colorName(r: number, g: number, b: number, context: 'frame' | 'picture' = 'picture'): string {
  const [hh, s, v] = rgbToHsv(r, g, b);
  if (v < 0.2) return 'black';
  if (s < 0.12) {
    if (v > 0.85) return 'white';
    if (v > 0.55) return context === 'frame' ? 'silver' : 'gray';
    return v < 0.3 ? 'black' : 'gray';
  }
  if (hh >= 20 && hh < 65 && s < 0.3 && v > 0.72) return 'cream';
  if (context === 'frame' && hh >= 35 && hh < 62 && s >= 0.3 && v > 0.5) return 'gold';
  if (hh >= 12 && hh < 48 && v < 0.62) return context === 'frame' ? 'wood' : 'brown';
  if (hh < 12 || hh >= 345) return s < 0.45 && v > 0.7 ? 'pink' : 'red';
  if (hh < 38) return 'orange';
  if (hh < 68) return 'yellow';
  if (hh < 165) return 'green';
  if (hh < 195) return 'teal';
  if (hh < 255) return 'blue';
  if (hh < 290) return 'purple';
  return 'pink';
}

/** Hue order used when sorting by colour. */
export const COLOR_ORDER = ['black', 'gray', 'silver', 'white', 'cream', 'gold', 'yellow', 'orange', 'wood', 'brown', 'red', 'pink', 'purple', 'blue', 'teal', 'green'];

/** Dominant colour of the pixels selected by `pick` (non-transparent by default). */
export function dominantColor(img: Img, pick: (x: number, y: number) => boolean, context: 'frame' | 'picture') {
  const { img: small, scale } = downscale(img, 200);
  const d = small.data;
  const rgb: number[] = [];
  for (let y = 0; y < small.height; y++) for (let x = 0; x < small.width; x++) {
    const o = (y * small.width + x) * 4;
    if (d[o + 3] < 128 || !pick(x / scale, y / scale)) continue;
    rgb.push(d[o], d[o + 1], d[o + 2]);
  }
  if (!rgb.length) return { name: 'gray', hex: '#888888' };
  const s = new Float32Array(rgb);
  const { centers, assign } = kmeans(s, 3, Math.min(4, rgb.length / 3));
  const counts = new Array(centers.length / 3).fill(0);
  for (const a of assign) counts[a]++;
  // Pictures: prefer a clearly coloured cluster if it's reasonably large.
  let best = 0;
  for (let c = 1; c < counts.length; c++) if (counts[c] > counts[best]) best = c;
  if (context === 'picture') {
    for (let c = 0; c < counts.length; c++) {
      const [, sat] = rgbToHsv(centers[c * 3], centers[c * 3 + 1], centers[c * 3 + 2]);
      if (sat > 0.3 && counts[c] / assign.length > 0.18 && counts[c] > counts[best] * 0.45) {
        const [, bs] = rgbToHsv(centers[best * 3], centers[best * 3 + 1], centers[best * 3 + 2]);
        if (bs < 0.2) best = c;
      }
    }
  }
  const r = centers[best * 3], g = centers[best * 3 + 1], b = centers[best * 3 + 2];
  return { name: colorName(r, g, b, context), hex: rgbToHex(r, g, b) };
}

export function classifyShape(outline: Pt[]): FrameShape {
  if (outline.length < 3) return 'rectangular';
  const b = bbox(outline);
  const fill = polygonArea(outline) / Math.max(1e-6, b.w * b.h);
  const perimRatio = polygonPerimeter(outline) / (2 * (b.w + b.h));
  // Ellipse: fill ≈ π/4 and points lie close to the inscribed ellipse.
  if (fill > 0.7 && fill < 0.84) {
    const cx = b.x0 + b.w / 2, cy = b.y0 + b.h / 2;
    let err = 0;
    for (const p of outline) err += Math.abs(Math.hypot((p.x - cx) / (b.w / 2), (p.y - cy) / (b.h / 2)) - 1);
    if (err / outline.length < 0.05) return 'circular/oval';
  }
  if (fill > 0.93 && perimRatio < 1.08) return 'rectangular';
  return 'irregular';
}
