import type { JSX } from 'preact';
// Renders a frame cut-out (clipped to its outline) with pictures swapped into its openings.
import { useBlobUrl } from './ui';
import type { Frame, OpeningFill, Picture } from '../lib/types';

export function clipPolygon(frame: Frame): string {
  const W = frame.widthIn + frame.padX * 2, H = frame.heightIn + frame.padY * 2;
  return `polygon(${frame.outline.map((p) => `${(((p.x + frame.padX) / W) * 100).toFixed(3)}% ${(((p.y + frame.padY) / H) * 100).toFixed(3)}%`).join(',')})`;
}

interface Props {
  frame: Frame;
  /** Screen pixels per inch. */
  s: number;
  fills?: Record<string, OpeningFill>;
  pictures?: Map<string, Picture>;
  selectedOpening?: string | null;
  /** Render tappable opening areas (with data-opening ids). */
  showOpenings?: boolean;
  shadow?: boolean;
}

/** Positioned so that (0,0) is the frame's nominal top-left; the image bleeds by pad on each side. */
export function FrameArt({ frame, s, fills, pictures, selectedOpening, showOpenings, shadow = true }: Props) {
  const url = useBlobUrl(frame.imageBlobId);
  const W = (frame.widthIn + frame.padX * 2) * s, H = (frame.heightIn + frame.padY * 2) * s;
  const clip = clipPolygon(frame);
  return (
    <div class={shadow ? 'shadow' : undefined} style={{ position: 'absolute', left: 0, top: 0, width: frame.widthIn * s, height: frame.heightIn * s }}>
      {url && (
        <img
          class="frame-img"
          src={url}
          draggable={false}
          style={{ left: -frame.padX * s, top: -frame.padY * s, width: W, height: H, clipPath: clip, WebkitClipPath: clip }}
        />
      )}
      {frame.openings.map((o) => {
        const fill = fills?.[o.id];
        const pic = fill && pictures?.get(fill.pictureId);
        const style = {
          left: o.x * s, top: o.y * s, width: o.w * s, height: o.h * s,
          borderRadius: o.shape === 'oval' ? '50%' : undefined,
        };
        return (
          <div key={o.id}>
            {pic && fill && <PictureInOpening picture={pic} fill={fill} w={o.w * s} h={o.h * s} style={style} />}
            {showOpenings && <div class={`opening-hit ${selectedOpening === o.id ? 'sel' : ''}`} data-opening={o.id} style={style} />}
          </div>
        );
      })}
    </div>
  );
}

function PictureInOpening({ picture, fill, w, h, style }: { picture: Picture; fill: OpeningFill; w: number; h: number; style: JSX.CSSProperties }) {
  const url = useBlobUrl(picture.imageBlobId);
  const quarter = Math.round(fill.rot / 90) % 2 !== 0;
  const aspect = quarter ? 1 / picture.aspect : picture.aspect;
  // "Cover" fit, then user zoom.
  const coverScale = Math.max(w / aspect, h) ; // height of the (rotated) picture box
  const boxH = coverScale * fill.scale;
  const boxW = boxH * aspect;
  const imgW = quarter ? boxH : boxW, imgH = quarter ? boxW : boxH;
  return (
    <div class="fill" style={style}>
      {url && (
        <img
          src={url}
          draggable={false}
          style={{
            width: imgW,
            height: imgH,
            transform: `translate(-50%, -50%) translate(${fill.ox * w}px, ${fill.oy * h}px) rotate(${fill.rot}deg)`,
          }}
        />
      )}
    </div>
  );
}

/** Frame thumbnail that fits in a box. */
export function FrameThumb({ frame, box }: { frame: Frame; box: number }) {
  const W = frame.widthIn + frame.padX * 2, H = frame.heightIn + frame.padY * 2;
  const s = box / Math.max(W, H);
  return (
    <div style={{ position: 'relative', width: W * s, height: H * s }}>
      <div style={{ position: 'absolute', left: frame.padX * s, top: frame.padY * s }}>
        <FrameArt frame={frame} s={s} />
      </div>
    </div>
  );
}
