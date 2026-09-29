// Draw a layout to a canvas (export images and project thumbnails).
import { blobUrl } from './db';
import { footprint, unionBox } from './arrange';
import { applyH, invert3, multiply3 } from './geometry';
import { loadImageElement, makeCanvas, toBlob } from './imaging';
import { localScale, scaleMat, wallToSource } from './projection';
import type { Frame, Layout, Picture, Project } from './types';

export interface RenderOpts {
  area: 'wall' | 'arrangement';
  maxSide: number;
  paint: boolean;
  guides?: boolean;
}

const imgCache = new Map<string, Promise<HTMLImageElement>>();
async function img(blobId: string) {
  let p = imgCache.get(blobId);
  if (!p) {
    p = blobUrl(blobId).then((u) => loadImageElement(u!));
    imgCache.set(blobId, p);
  }
  return p;
}

export async function renderLayout(project: Project, layout: Layout, frames: Map<string, Frame>, pictures: Map<string, Picture>, o: RenderOpts): Promise<HTMLCanvasElement> {
  const wall = project.wall;
  const items = layout.items.filter((i) => frames.has(i.frameId));
  const boxes = items.map((i) => footprint(i, frames.get(i.frameId)!));
  let x0: number, y0: number, x1: number, y1: number;
  const u = unionBox(boxes);
  if (o.area === 'arrangement' && u) {
    const m = Math.max(10, Math.max(u.w, u.h) * 0.25);
    x0 = u.x - m; y0 = u.y - m; x1 = u.x + u.w + m; y1 = u.y + u.h + m;
  } else if (wall) {
    x0 = wall.x0; y0 = wall.y0; x1 = wall.x1; y1 = wall.y1;
  } else {
    x0 = -12; y0 = -12; x1 = 132; y1 = 108;
  }
  const s = o.maxSide / Math.max(x1 - x0, y1 - y0);
  const c = makeCanvas((x1 - x0) * s, (y1 - y0) * s);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#e9e6df';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.setTransform(s, 0, 0, s, -x0 * s, -y0 * s); // draw in wall inches

  if (wall) {
    const wid = o.paint && project.settings.showPaint && wall.paintedBlobId ? wall.paintedBlobId : wall.imageBlobId;
    const w = await img(wid);
    ctx.drawImage(w, wall.x0, wall.y0, wall.x1 - wall.x0, wall.y1 - wall.y0);
  }

  await drawItems(ctx, items, frames, pictures, s);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return c;
}

export async function renderToBlob(...args: Parameters<typeof renderLayout>): Promise<Blob> {
  return toBlob(await renderAuto(...args), 'image/png');
}

/** Render in whichever view the project is using (photo perspective or straightened). */
export function renderAuto(...args: Parameters<typeof renderLayout>): Promise<HTMLCanvasElement> {
  const [project] = args;
  return project.wall && project.settings.viewMode !== 'straight' ? renderPhotoLayout(...args) : renderLayout(...args);
}

/** Draw frames (with their pictures) using the context's current transform, in wall inches. */
async function drawItems(ctx: CanvasRenderingContext2D, items: Layout['items'], frames: Map<string, Frame>, pictures: Map<string, Picture>, s: number) {
  for (const it of items) {
    const f = frames.get(it.frameId)!;
    ctx.save();
    ctx.translate(it.x, it.y);
    ctx.rotate((it.rotation * Math.PI) / 180);
    ctx.translate(-f.widthIn / 2, -f.heightIn / 2);
    const outline = new Path2D();
    f.outline.forEach((p, i) => (i ? outline.lineTo(p.x, p.y) : outline.moveTo(p.x, p.y)));
    outline.closePath();
    // Soft shadow under the frame.
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 0.6 * s;
    ctx.shadowOffsetY = 0.35 * s;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fill(outline);
    ctx.restore();
    ctx.save();
    ctx.clip(outline);
    ctx.drawImage(await img(f.imageBlobId), -f.padX, -f.padY, f.widthIn + f.padX * 2, f.heightIn + f.padY * 2);
    ctx.restore();
    for (const op of f.openings) {
      const fill = it.fills[op.id];
      const pic = fill && pictures.get(fill.pictureId);
      if (!fill || !pic) continue;
      ctx.save();
      const clip = new Path2D();
      if (op.shape === 'oval') clip.ellipse(op.x + op.w / 2, op.y + op.h / 2, op.w / 2, op.h / 2, 0, 0, Math.PI * 2);
      else clip.rect(op.x, op.y, op.w, op.h);
      ctx.clip(clip);
      const quarter = Math.round(fill.rot / 90) % 2 !== 0;
      const aspect = quarter ? 1 / pic.aspect : pic.aspect;
      const boxH = Math.max(op.w / aspect, op.h) * fill.scale;
      const boxW = boxH * aspect;
      const iw = quarter ? boxH : boxW, ih = quarter ? boxW : boxH;
      ctx.translate(op.x + op.w / 2 + fill.ox * op.w, op.y + op.h / 2 + fill.oy * op.h);
      ctx.rotate((fill.rot * Math.PI) / 180);
      ctx.drawImage(await img(pic.imageBlobId), -iw / 2, -ih / 2, iw, ih);
      ctx.restore();
      // Inner shadow line where the mat bevel meets the picture.
      ctx.save();
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 0.06;
      ctx.stroke(clip);
      ctx.restore();
    }
    ctx.restore();
  }
}

/**
 * Photo mode: the frames are drawn flat on a wall-space layer, then projected into the photo
 * through the wall's perspective (inverse mapping with bilinear sampling and alpha blending).
 */
export async function renderPhotoLayout(project: Project, layout: Layout, frames: Map<string, Frame>, pictures: Map<string, Picture>, o: RenderOpts): Promise<HTMLCanvasElement> {
  const wall = project.wall!;
  const srcId = o.paint && project.settings.showPaint && wall.paintedSrcBlobId ? wall.paintedSrcBlobId : wall.sourceBlobId;
  const base = await img(srcId);
  const k = Math.min(1, o.maxSide / Math.max(base.naturalWidth, base.naturalHeight));
  const out = makeCanvas(base.naturalWidth * k, base.naturalHeight * k);
  const octx = out.getContext('2d')!;
  octx.drawImage(base, 0, 0, out.width, out.height);
  const items = layout.items.filter((i) => frames.has(i.frameId));
  const u = unionBox(items.map((i) => footprint(i, frames.get(i.frameId)!)));
  if (!u) return out;
  // Wall inches → output pixels.
  const H = multiply3(scaleMat(k), wallToSource(wall));
  const pad = 2;
  const lx0 = u.x - pad, ly0 = u.y - pad, lw = u.w + pad * 2, lh = u.h + pad * 2;
  const ppi = Math.min(3000 / Math.max(lw, lh), Math.max(8, localScale(H, { x: u.x + u.w / 2, y: u.y + u.h / 2 }) * 1.5));
  const layer = makeCanvas(lw * ppi, lh * ppi);
  const lctx = layer.getContext('2d')!;
  lctx.setTransform(ppi, 0, 0, ppi, -lx0 * ppi, -ly0 * ppi);
  await drawItems(lctx, items, frames, pictures, ppi);
  const L = lctx.getImageData(0, 0, layer.width, layer.height);
  // Bounding box of the layer in the output.
  const corners = [[lx0, ly0], [lx0 + lw, ly0], [lx0 + lw, ly0 + lh], [lx0, ly0 + lh]].map(([x, y]) => applyH(H, x, y));
  const bx0 = Math.max(0, Math.floor(Math.min(...corners.map((p) => p.x)))), bx1 = Math.min(out.width, Math.ceil(Math.max(...corners.map((p) => p.x))));
  const by0 = Math.max(0, Math.floor(Math.min(...corners.map((p) => p.y)))), by1 = Math.min(out.height, Math.ceil(Math.max(...corners.map((p) => p.y))));
  if (bx1 <= bx0 || by1 <= by0) return out;
  const O = octx.getImageData(bx0, by0, bx1 - bx0, by1 - by0);
  const Hi = invert3(H);
  const LW = layer.width, LH = layer.height, ld = L.data, od = O.data;
  for (let y = 0; y < O.height; y++) {
    for (let x = 0; x < O.width; x++) {
      const p = applyH(Hi, bx0 + x + 0.5, by0 + y + 0.5);
      const sx = (p.x - lx0) * ppi - 0.5, sy = (p.y - ly0) * ppi - 0.5;
      if (sx < 0 || sy < 0 || sx >= LW - 1 || sy >= LH - 1) continue;
      const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * LW + x0) * 4, i10 = i00 + 4, i01 = i00 + LW * 4, i11 = i01 + 4;
      const a = (ld[i00 + 3] * (1 - fx) + ld[i10 + 3] * fx) * (1 - fy) + (ld[i01 + 3] * (1 - fx) + ld[i11 + 3] * fx) * fy;
      if (a <= 0) continue;
      const o = (y * O.width + x) * 4, al = a / 255;
      for (let c = 0; c < 3; c++) {
        // Premultiply while interpolating so edges don't pick up dark fringes.
        const v = ((ld[i00 + c] * ld[i00 + 3] * (1 - fx) + ld[i10 + c] * ld[i10 + 3] * fx) * (1 - fy) + (ld[i01 + c] * ld[i01 + 3] * (1 - fx) + ld[i11 + c] * ld[i11 + 3] * fx) * fy) / Math.max(1, a);
        od[o + c] = od[o + c] * (1 - al) + v * al;
      }
    }
  }
  octx.putImageData(O, bx0, by0);
  return out;
}
