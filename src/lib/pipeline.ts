// Higher-level steps shared by the editors.
import { getBlob, putBlob } from './db';
import { classifyShape, dominantColor } from './detect';
import { pointInPolygon } from './geometry';
import { canvasToImg, imgToCanvas, loadPhoto, pxPerUnitFor, toBlob, warp, type Img } from './imaging';
import type { FrameTags, Opening, PictureTags, Pt, Quad } from './types';
import { sizeGroup } from './units';

/** Let the browser paint (e.g. a spinner) before running heavy synchronous work. */
export const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 16)));

export async function loadSource(file: Blob) {
  const canvas = await loadPhoto(file);
  const blob = await toBlob(canvas, 'image/jpeg', 0.9);
  return { canvas, img: canvasToImg(canvas), blob };
}

export async function loadStoredSource(id: string) {
  const b = await getBlob(id);
  if (!b) return null;
  const canvas = await loadPhoto(b);
  return { canvas, img: canvasToImg(canvas) };
}

export interface Straightened { img: Img; canvas: HTMLCanvasElement; url: string; ppi: number; padX: number; padY: number }

/** Straighten a frame photo to its measured size, with padding so ornaments aren't clipped. */
export function straightenFrame(src: Img, quad: Quad, wIn: number, hIn: number, fine: number, maxSide = 1600): Straightened {
  const pad = Math.max(0.75, Math.max(wIn, hIn) * 0.08);
  const ppi = Math.min(90, pxPerUnitFor(wIn + pad * 2, hIn + pad * 2, maxSide));
  const img = warp(src, { quad, w: wIn, h: hIn, x0: -pad, y0: -pad, x1: wIn + pad, y1: hIn + pad, pxPerUnit: ppi, fineRotation: fine });
  const canvas = imgToCanvas(img);
  return { img, canvas, url: canvas.toDataURL('image/jpeg', 0.85), ppi, padX: pad, padY: pad };
}

/** Rectify a print/photo: output aspect comes from the print size if known, else from the pins. */
export function straightenPicture(src: Img, quad: Quad, fine: number, printW?: number, printH?: number, maxSide = 1800) {
  const len = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
  const w = printW && printH ? printW : (len(quad[0], quad[1]) + len(quad[3], quad[2])) / 2;
  const h = printW && printH ? printH : (len(quad[0], quad[3]) + len(quad[1], quad[2])) / 2;
  const ppu = pxPerUnitFor(w, h, maxSide);
  const img = warp(src, { quad, w, h, x0: 0, y0: 0, x1: w, y1: h, pxPerUnit: ppu, fineRotation: fine });
  return { img, canvas: imgToCanvas(img), aspect: w / h };
}

export function autoFrameTags(s: Straightened, outline: Pt[], openings: Opening[], matted: boolean, wIn: number, hIn: number): Omit<FrameTags, 'custom'> {
  const inOpening = (x: number, y: number) => openings.some((o) => x >= o.x - 0.1 && x <= o.x + o.w + 0.1 && y >= o.y - 0.1 && y <= o.y + o.h + 0.1);
  // Frame colour: pixels near the outline (the molding), excluding openings.
  const inner = shrink(outline, Math.min(wIn, hIn) * 0.12);
  const col = dominantColor(s.img, (px, py) => {
    const x = px / s.ppi - s.padX, y = py / s.ppi - s.padY;
    const p = { x, y };
    return pointInPolygon(p, outline) && !inOpening(x, y) && (!matted || !pointInPolygon(p, inner));
  }, 'frame');
  return {
    shape: classifyShape(outline),
    color: col.name,
    colorHex: col.hex,
    matted: matted || openings.length > 1,
    size: sizeGroup(wIn, hIn),
  };
}

function shrink(poly: Pt[], by: number): Pt[] {
  const cx = poly.reduce((a, p) => a + p.x, 0) / poly.length;
  const cy = poly.reduce((a, p) => a + p.y, 0) / poly.length;
  return poly.map((p) => {
    const d = Math.hypot(p.x - cx, p.y - cy) || 1;
    const k = Math.max(0, (d - by) / d);
    return { x: cx + (p.x - cx) * k, y: cy + (p.y - cy) * k };
  });
}

export function autoPictureTags(img: Img, aspect: number): Omit<PictureTags, 'custom'> {
  const col = dominantColor(img, () => true, 'picture');
  return {
    orientation: aspect > 1.05 ? 'landscape' : aspect < 0.95 ? 'portrait' : 'square',
    color: col.name,
    colorHex: col.hex,
  };
}

export async function storeCanvas(c: HTMLCanvasElement, type = 'image/jpeg', q = 0.9) {
  return putBlob(await toBlob(c, type, q));
}

/** Common print sizes, for labelling pictures. */
export const PRINT_SIZES: [number, number][] = [
  [4, 6], [5, 7], [8, 10], [8.5, 11], [11, 14], [12, 16], [16, 20], [18, 24], [24, 36],
];

export function printSizeLabel(aspect: number): string | null {
  const a = aspect >= 1 ? aspect : 1 / aspect;
  let best: [number, number] | null = null, err = 0.03;
  for (const s of PRINT_SIZES) {
    const e = Math.abs(s[1] / s[0] - a);
    if (e < err) { err = e; best = s; }
  }
  return best ? `${best[0]}×${best[1]} ratio` : null;
}
