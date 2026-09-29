// Editable polygon over a photo: drag points (with loupe), tap an edge to add a point,
// double-tap a point to remove it (minimum three).
import type { ComponentChildren } from 'preact';
import { useRef, useState } from 'preact/hooks';
import type { Pt } from '../lib/types';
import { PhotoStage, type StageApi } from './PhotoStage';

interface Props {
  src: string | undefined;
  imgW: number;
  imgH: number;
  pts: Pt[];
  onChange: (pts: Pt[]) => void;
  under?: (api: StageApi) => ComponentChildren;
}

export function PolygonPins(p: Props) {
  const [drag, setDrag] = useState<number | null>(null);
  const [loupe, setLoupe] = useState<Pt | null>(null);
  const lastTap = useRef<{ i: number; t: number } | null>(null);
  const pts = p.pts;
  return (
    <PhotoStage src={p.src} imgW={p.imgW} imgH={p.imgH} loupe={loupe} padding={56}>
      {(api) => {
        const startDrag = (i: number, e: PointerEvent) => {
          e.stopPropagation();
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
          setDrag(i);
          setLoupe(pts[i]);
        };
        const moveDrag = (i: number, e: PointerEvent, list = pts) => {
          if (drag !== i) return;
          e.stopPropagation();
          const m = api.toImage(e.clientX, e.clientY);
          const next = [...list];
          next[i] = m;
          p.onChange(next);
          setLoupe(m);
        };
        const endDrag = (e: PointerEvent) => { e.stopPropagation(); setDrag(null); setLoupe(null); };
        return (
          <>
            {p.under?.(api)}
            <polygon class="quad" points={pts.map((q) => `${q.x},${q.y}`).join(' ')} style={{ strokeWidth: api.px(2) }} />
            {pts.map((a, i) => {
              const b = pts[(i + 1) % pts.length];
              return (
                <line
                  key={`e${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" stroke-width={api.px(22)}
                  data-testid={`poly-edge-${i}`}
                  onPointerDown={(e) => {
                    // Tap an edge: insert a point there and start dragging it.
                    e.stopPropagation();
                    const m = api.toImage(e.clientX, e.clientY);
                    const next = [...pts];
                    next.splice(i + 1, 0, m);
                    p.onChange(next);
                    (e.currentTarget as Element).setPointerCapture(e.pointerId);
                    setDrag(i + 1);
                    setLoupe(m);
                  }}
                  onPointerMove={(e) => {
                    if (drag !== i + 1) return;
                    const m = api.toImage(e.clientX, e.clientY);
                    const next = [...pts];
                    next[i + 1] = m;
                    p.onChange(next);
                    setLoupe(m);
                  }}
                  onPointerUp={endDrag as any}
                />
              );
            })}
            {pts.map((q, i) => (
              <g key={`v${i}`}>
                <circle class="pin" cx={q.x} cy={q.y} r={api.px(drag === i ? 14 : 11)} style={{ strokeWidth: api.px(2.5) }} />
                <circle cx={q.x} cy={q.y} r={api.px(2)} fill="white" />
                <circle
                  cx={q.x} cy={q.y} r={api.px(24)} fill="transparent" style={{ cursor: 'grab' }}
                  data-testid={`poly-pt-${i}`}
                  onPointerDown={(e) => {
                    const now = Date.now();
                    if (lastTap.current && lastTap.current.i === i && now - lastTap.current.t < 350 && pts.length > 3) {
                      e.stopPropagation();
                      lastTap.current = null;
                      p.onChange(pts.filter((_, k) => k !== i));
                      return;
                    }
                    lastTap.current = { i, t: now };
                    startDrag(i, e as unknown as PointerEvent);
                  }}
                  onPointerMove={(e) => moveDrag(i, e as unknown as PointerEvent)}
                  onPointerUp={endDrag as any}
                  onPointerCancel={() => { setDrag(null); setLoupe(null); }}
                />
              </g>
            ))}
          </>
        );
      }}
    </PhotoStage>
  );
}
