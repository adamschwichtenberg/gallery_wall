// Draw a layout to a canvas (export images and project thumbnails).
import { blobUrl } from './db';
import { footprint, unionBox } from './arrange';
import { loadImageElement, makeCanvas, toBlob } from './imaging';
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
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return c;
}

export async function renderToBlob(...args: Parameters<typeof renderLayout>): Promise<Blob> {
  return toBlob(await renderLayout(...args), 'image/png');
}
