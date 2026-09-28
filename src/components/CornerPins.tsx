// Four draggable corner pins (with loupe) over a PhotoStage.
import { useState } from 'preact/hooks';
import type { Pt, Quad } from '../lib/types';
import { PhotoStage, type StageApi } from './PhotoStage';

interface Props {
  src: string | undefined;
  imgW: number;
  imgH: number;
  quad: Quad;
  onChange: (q: Quad) => void;
  /** Extra SVG (e.g. a contour preview) drawn under the pins. */
  under?: (api: StageApi) => preact.ComponentChildren;
  labels?: [string, string, string, string];
  edgeLabels?: { top?: string; right?: string; bottom?: string; left?: string };
}

export function CornerPins(props: Props) {
  const [drag, setDrag] = useState<{ i: number; off: Pt } | null>(null);
  const [loupe, setLoupe] = useState<Pt | null>(null);
  const q = props.quad;
  const labels = props.labels ?? ['', '', '', ''];

  return (
    <PhotoStage src={props.src} imgW={props.imgW} imgH={props.imgH} loupe={loupe} padding={56}>
      {(api) => {
        const r = api.px(13);
        const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        const edges: [keyof NonNullable<Props['edgeLabels']>, Pt][] = [
          ['top', mid(q[0], q[1])],
          ['right', mid(q[1], q[2])],
          ['bottom', mid(q[2], q[3])],
          ['left', mid(q[3], q[0])],
        ];
        return (
          <>
            {props.under?.(api)}
            <polygon class="quad" points={q.map((p) => `${p.x},${p.y}`).join(' ')} style={{ strokeWidth: api.px(2) }} />
            {props.edgeLabels &&
              edges.map(([k, p]) =>
                props.edgeLabels![k] ? (
                  <text key={k} class="svg-label" x={p.x} y={p.y} text-anchor="middle" style={{ fontSize: api.px(13), strokeWidth: api.px(3) }}>
                    {props.edgeLabels![k]}
                  </text>
                ) : null,
              )}
            {q.map((p, i) => (
              <g key={i}>
                <circle class="pin" cx={p.x} cy={p.y} r={r} style={{ strokeWidth: api.px(2.5) }} />
                <circle cx={p.x} cy={p.y} r={api.px(2)} fill="white" />
                {labels[i] && (
                  <text class="pin-label" x={p.x} y={p.y - r - api.px(10)} style={{ fontSize: api.px(12) }}>
                    {labels[i]}
                  </text>
                )}
                <circle
                  class="pin-hit"
                  data-testid={`pin-${i}`}
                  cx={p.x}
                  cy={p.y}
                  r={api.px(28)}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    (e.currentTarget as Element).setPointerCapture(e.pointerId);
                    const m = api.toImage(e.clientX, e.clientY);
                    setDrag({ i, off: { x: p.x - m.x, y: p.y - m.y } });
                    setLoupe(p);
                  }}
                  onPointerMove={(e) => {
                    if (!drag || drag.i !== i) return;
                    e.stopPropagation();
                    const m = api.toImage(e.clientX, e.clientY);
                    const np = {
                      x: Math.max(-props.imgW * 0.5, Math.min(props.imgW * 1.5, m.x + drag.off.x)),
                      y: Math.max(-props.imgH * 0.5, Math.min(props.imgH * 1.5, m.y + drag.off.y)),
                    };
                    const nq = [...q] as Quad;
                    nq[i] = np;
                    props.onChange(nq);
                    setLoupe(np);
                  }}
                  onPointerUp={(e) => {
                    e.stopPropagation();
                    setDrag(null);
                    setLoupe(null);
                  }}
                  onPointerCancel={() => {
                    setDrag(null);
                    setLoupe(null);
                  }}
                />
              </g>
            ))}
          </>
        );
      }}
    </PhotoStage>
  );
}
