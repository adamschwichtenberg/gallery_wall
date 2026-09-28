import { loadPhoto, canvasToImg, warp, imgToCanvas } from '../src/lib/imaging';
import { detectFrame, contourToOutline, detectOpenings, dominantColor, classifyShape } from '../src/lib/detect';
import { pointInPolygon } from '../src/lib/geometry';

const out = document.getElementById('out')!;
const sizes: Record<string, [number, number]> = { '4': [13, 15], '5': [12, 14] };
(window as any).results = {};
for (const name of ['4', '5']) {
  const blob = await (await fetch(`./samples/${name}.jpg`)).blob();
  const c = await loadPhoto(blob, 1600);
  const src = canvasToImg(c);
  const t0 = performance.now();
  const det = detectFrame(src);
  const t1 = performance.now();
  const ctx = c.getContext('2d')!;
  if (!det) { out.append(`no detection ${name}`); continue; }
  ctx.strokeStyle = 'lime'; ctx.lineWidth = 3; ctx.beginPath();
  det.contour.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath(); ctx.stroke();
  ctx.fillStyle = 'red'; det.quad.forEach(p => { ctx.beginPath(); ctx.arc(p.x, p.y, 10, 0, 7); ctx.fill(); });
  c.style.width = '600px'; out.append(c);
  const [w, h] = sizes[name];
  const pad = 0.08 * Math.max(w, h), ppi = 40;
  const r = warp(src, { quad: det.quad, w, h, x0: -pad, y0: -pad, x1: w + pad, y1: h + pad, pxPerUnit: ppi });
  const outline = contourToOutline(det.contour, det.quad, w, h);
  const ops = detectOpenings(r, ppi, pad, pad, w, h);
  const t2 = performance.now();
  const rc = imgToCanvas(r); const rx = rc.getContext('2d')!;
  rx.strokeStyle = 'lime'; rx.lineWidth = 2; rx.beginPath();
  outline.forEach((p, i) => i ? rx.lineTo((p.x + pad) * ppi, (p.y + pad) * ppi) : rx.moveTo((p.x + pad) * ppi, (p.y + pad) * ppi)); rx.closePath(); rx.stroke();
  rx.strokeStyle = 'cyan';
  ops.openings.forEach(o => rx.strokeRect((o.x + pad) * ppi, (o.y + pad) * ppi, o.w * ppi, o.h * ppi));
  rc.style.width = '500px'; out.append(rc);
  const inOpen = (x: number, y: number) => ops.openings.some(o => x >= o.x && x <= o.x + o.w && y >= o.y && y <= o.y + o.h);
  const col = dominantColor(r, (x, y) => { const xi = x / ppi - pad, yi = y / ppi - pad; return pointInPolygon({ x: xi, y: yi }, outline) && !inOpen(xi, yi) && !(ops.matted && xi > w*0.12 && xi < w*0.88 && yi > h*0.12 && yi < h*0.88); }, 'frame');
  (window as any).results[name] = { segMs: Math.round(t1 - t0), restMs: Math.round(t2 - t1), quad: det.quad.map(p => [Math.round(p.x), Math.round(p.y)]), n: outline.length, shape: classifyShape(outline), matted: ops.matted, openings: ops.openings.map(o => [o.x, o.y, o.w, o.h]), color: col };
}
(window as any).done = true;
