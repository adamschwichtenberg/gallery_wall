// Numbered, colour-coded reference points on a photo: drag to move, tap empty space to add.
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import type { Pt } from '../lib/types';
import { PhotoStage, type StageApi } from './PhotoStage';

export const POINT_COLORS = ['#ff5a5f', '#4f8dff', '#34c759', '#ffc94f', '#b36bff', '#ff8a3d', '#2bd4c6', '#ff6fb5'];

interface Props {
  src: string | undefined;
  imgW: number;
  imgH: number;
  pts: (Pt | null)[];
  selected: number | null;
  onSelect: (i: number) => void;
  onMove: (i: number, p: Pt) => void;
  /** Tap on empty photo (only when provided). */
  onTap?: (p: Pt) => void;
  extra?: (api: StageApi) => ComponentChildren;
  html?: (api: StageApi) => ComponentChildren;
  testid?: string;
}

export function PointPins(p: Props) {
  const [drag, setDrag] = useState<{ i: number; off: Pt } | null>(null);
  const [loupe, setLoupe] = useState<Pt | null>(null);
  return (
    <PhotoStage
      src={p.src}
      imgW={p.imgW}
      imgH={p.imgH}
      loupe={loupe}
      padding={24}
      html={p.html}
      onTap={p.onTap}
    >
      {(api) => (
        <g data-testid={p.testid}>
          {p.extra?.(api)}
          {p.pts.map((q, i) =>
            q ? (
              <g key={i}>
                <circle cx={q.x} cy={q.y} r={api.px(p.selected === i ? 15 : 12)} fill={`${POINT_COLORS[i % POINT_COLORS.length]}44`} stroke={POINT_COLORS[i % POINT_COLORS.length]} stroke-width={api.px(3)} />
                <circle cx={q.x} cy={q.y} r={api.px(2)} fill="white" />
                <text class="pin-label" x={q.x} y={q.y - api.px(24)} style={{ fontSize: api.px(13) }}>{i + 1}</text>
                <circle
                  data-testid={`${p.testid}-pt-${i}`}
                  cx={q.x} cy={q.y} r={api.px(26)} fill="transparent" style={{ cursor: 'grab' }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    (e.currentTarget as Element).setPointerCapture(e.pointerId);
                    const m = api.toImage(e.clientX, e.clientY);
                    setDrag({ i, off: { x: q.x - m.x, y: q.y - m.y } });
                    setLoupe(q);
                    p.onSelect(i);
                  }}
                  onPointerMove={(e) => {
                    if (!drag || drag.i !== i) return;
                    e.stopPropagation();
                    const m = api.toImage(e.clientX, e.clientY);
                    const np = { x: m.x + drag.off.x, y: m.y + drag.off.y };
                    p.onMove(i, np);
                    setLoupe(np);
                  }}
                  onPointerUp={(e) => { e.stopPropagation(); setDrag(null); setLoupe(null); }}
                  onPointerCancel={() => { setDrag(null); setLoupe(null); }}
                />
              </g>
            ) : null,
          )}
        </g>
      )}
    </PhotoStage>
  );
}
