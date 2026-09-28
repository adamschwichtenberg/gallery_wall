// Edit a frame's cut-out outline over its straightened image.
// Tools: drag vertices (tap an edge to add a point, double-tap a point to delete), freehand lasso,
// rectangle and oval presets. Coordinates are frame inches; the stage works in image pixels.
import { useState } from 'preact/hooks';
import { dist, ellipsePoly, rectPoly, simplify } from '../lib/geometry';
import type { Pt } from '../lib/types';
import { PhotoStage } from './PhotoStage';

export type OutlineTool = 'edit' | 'lasso';

interface Props {
  src: string | undefined;
  imgW: number;
  imgH: number;
  ppi: number;
  padX: number;
  padY: number;
  outline: Pt[];
  onChange: (o: Pt[]) => void;
  tool: OutlineTool;
  /** Nominal frame size for reference. */
  wIn: number;
  hIn: number;
}

export function OutlineEditor(p: Props) {
  const toPx = (q: Pt): Pt => ({ x: (q.x + p.padX) * p.ppi, y: (q.y + p.padY) * p.ppi });
  const toIn = (q: Pt): Pt => ({ x: q.x / p.ppi - p.padX, y: q.y / p.ppi - p.padY });
  const [drag, setDrag] = useState<number | null>(null);
  const [loupe, setLoupe] = useState<Pt | null>(null);
  const [stroke, setStroke] = useState<Pt[] | null>(null);
  const [lastTap, setLastTap] = useState<{ i: number; t: number } | null>(null);
  const px = p.outline.map(toPx);

  return (
    <PhotoStage
      src={p.src}
      imgW={p.imgW}
      imgH={p.imgH}
      loupe={loupe}
      checker
      onBackgroundDown={(e, api) => {
        if (p.tool !== 'lasso') return false;
        const m = api.toImage(e.clientX, e.clientY);
        setStroke([m]);
        setLoupe(m);
        return true;
      }}
      onBackgroundMove={(e, api) => {
        if (!stroke) return;
        const m = api.toImage(e.clientX, e.clientY);
        if (dist(m, stroke[stroke.length - 1]) > api.px(3)) setStroke([...stroke, m]);
        setLoupe(m);
      }}
      onBackgroundUp={() => {
        if (stroke && stroke.length > 8) {
          const s = simplify(stroke.map(toIn), Math.max(p.wIn, p.hIn) * 0.002);
          p.onChange(s);
        }
        setStroke(null);
        setLoupe(null);
      }}
    >
      {(api) => (
        <>
          <rect class="ref-rect" x={p.padX * p.ppi} y={p.padY * p.ppi} width={p.wIn * p.ppi} height={p.hIn * p.ppi} style={{ strokeWidth: api.px(1) }} />
          {/* Dim everything outside the outline. */}
          <path
            d={`M0,0H${p.imgW}V${p.imgH}H0Z M${px.map((q) => `${q.x},${q.y}`).join('L')}Z`}
            fill="rgba(0,0,0,0.55)"
            fill-rule="evenodd"
          />
          <polygon class="outline-path" points={px.map((q) => `${q.x},${q.y}`).join(' ')} style={{ strokeWidth: api.px(2) }} />
          {stroke && <polyline points={stroke.map((q) => `${q.x},${q.y}`).join(' ')} fill="none" stroke="#ffc94f" stroke-width={api.px(2.5)} />}
          {p.tool === 'edit' &&
            px.map((a, i) => {
              const b = px[(i + 1) % px.length];
              // Invisible fat edge: tap to insert a vertex.
              return (
                <line
                  key={`e${i}`}
                  x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  stroke="transparent"
                  stroke-width={api.px(18)}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    const m = api.toImage(e.clientX, e.clientY);
                    const next = [...p.outline];
                    next.splice(i + 1, 0, toIn(m));
                    p.onChange(next);
                    setDrag(i + 1);
                    (e.currentTarget as Element).setPointerCapture(e.pointerId);
                  }}
                  onPointerMove={(e) => {
                    if (drag !== i + 1) return;
                    const m = api.toImage(e.clientX, e.clientY);
                    const next = [...p.outline];
                    next[i + 1] = toIn(m);
                    p.onChange(next);
                    setLoupe(m);
                  }}
                  onPointerUp={() => { setDrag(null); setLoupe(null); }}
                />
              );
            })}
          {p.tool === 'edit' &&
            px.map((q, i) => (
              <g key={`v${i}`}>
                <circle class="vertex" cx={q.x} cy={q.y} r={api.px(drag === i ? 8 : 4)} style={{ strokeWidth: api.px(1.5) }} />
                <circle
                  cx={q.x} cy={q.y} r={api.px(20)} fill="transparent"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    const now = Date.now();
                    if (lastTap && lastTap.i === i && now - lastTap.t < 350 && p.outline.length > 3) {
                      p.onChange(p.outline.filter((_, k) => k !== i));
                      setLastTap(null);
                      return;
                    }
                    setLastTap({ i, t: now });
                    (e.currentTarget as Element).setPointerCapture(e.pointerId);
                    setDrag(i);
                    setLoupe(q);
                  }}
                  onPointerMove={(e) => {
                    if (drag !== i) return;
                    e.stopPropagation();
                    const m = api.toImage(e.clientX, e.clientY);
                    const next = [...p.outline];
                    next[i] = toIn(m);
                    p.onChange(next);
                    setLoupe(m);
                  }}
                  onPointerUp={(e) => { e.stopPropagation(); setDrag(null); setLoupe(null); }}
                />
              </g>
            ))}
        </>
      )}
    </PhotoStage>
  );
}

export function presetOutline(kind: 'rect' | 'oval', wIn: number, hIn: number): Pt[] {
  return kind === 'rect' ? rectPoly(0, 0, wIn, hIn) : ellipsePoly(0, 0, wIn, hIn, 72);
}
