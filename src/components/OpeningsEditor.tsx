// Draw / move / resize picture openings on a straightened frame image.
import { useState } from 'preact/hooks';
import type { Opening, Pt } from '../lib/types';
import { PhotoStage } from './PhotoStage';

interface Props {
  src: string | undefined;
  imgW: number;
  imgH: number;
  ppi: number;
  padX: number;
  padY: number;
  outline: Pt[];
  openings: Opening[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onChange: (ops: Opening[]) => void;
  label: (o: Opening) => string;
}

type Drag = { id: string; mode: 'move' | 'tl' | 'tr' | 'br' | 'bl'; start: Opening; p0: Pt };

export function OpeningsEditor(p: Props) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const [loupe, setLoupe] = useState<Pt | null>(null);
  const X = (x: number) => (x + p.padX) * p.ppi;
  const Y = (y: number) => (y + p.padY) * p.ppi;
  const q = (v: number) => Math.round(v * 16) / 16; // 1/16" while dragging; display rounds to 1/4"

  const update = (id: string, o: Opening) => p.onChange(p.openings.map((x) => (x.id === id ? o : x)));

  return (
    <PhotoStage
      src={p.src}
      imgW={p.imgW}
      imgH={p.imgH}
      loupe={loupe}
      checker
      onBackgroundDown={() => {
        p.onSelect(null);
        return false;
      }}
    >
      {(api) => {
        const start = (id: string, mode: Drag['mode']) => (e: PointerEvent) => {
          e.stopPropagation();
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
          const o = p.openings.find((x) => x.id === id)!;
          p.onSelect(id);
          const m = api.toImage(e.clientX, e.clientY);
          setDrag({ id, mode, start: { ...o }, p0: m });
          if (mode !== 'move') setLoupe(m);
        };
        const move = (e: PointerEvent) => {
          if (!drag) return;
          e.stopPropagation();
          const m = api.toImage(e.clientX, e.clientY);
          const dx = (m.x - drag.p0.x) / p.ppi, dy = (m.y - drag.p0.y) / p.ppi;
          const s = drag.start;
          let o: Opening = { ...s };
          if (drag.mode === 'move') o = { ...s, x: q(s.x + dx), y: q(s.y + dy) };
          else {
            let x0 = s.x, y0 = s.y, x1 = s.x + s.w, y1 = s.y + s.h;
            if (drag.mode.includes('l')) x0 = q(x0 + dx);
            if (drag.mode.includes('r')) x1 = q(x1 + dx);
            if (drag.mode.includes('t')) y0 = q(y0 + dy);
            if (drag.mode.includes('b')) y1 = q(y1 + dy);
            o = { ...s, x: Math.min(x0, x1 - 0.5), y: Math.min(y0, y1 - 0.5), w: Math.max(0.5, x1 - x0), h: Math.max(0.5, y1 - y0) };
            setLoupe(m);
          }
          update(drag.id, o);
        };
        const end = (e: PointerEvent) => {
          e.stopPropagation();
          setDrag(null);
          setLoupe(null);
        };
        return (
          <>
            <polygon points={p.outline.map((pt) => `${X(pt.x)},${Y(pt.y)}`).join(' ')} fill="none" stroke="rgba(110,231,168,0.6)" stroke-width={api.px(1.5)} />
            {p.openings.map((o) => {
              const sel = o.id === p.selected;
              const x = X(o.x), y = Y(o.y), w = o.w * p.ppi, h = o.h * p.ppi;
              const hr = api.px(9);
              return (
                <g key={o.id}>
                  {o.shape === 'oval' ? (
                    <ellipse class={`opening-rect ${sel ? 'sel' : ''}`} cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} style={{ strokeWidth: api.px(2) }} />
                  ) : (
                    <rect class={`opening-rect ${sel ? 'sel' : ''}`} x={x} y={y} width={w} height={h} style={{ strokeWidth: api.px(2) }} />
                  )}
                  <rect
                    x={x} y={y} width={w} height={h} fill="transparent" style={{ cursor: 'move' }}
                    data-testid={`opening-${o.id}`}
                    onPointerDown={start(o.id, 'move') as any}
                    onPointerMove={move as any}
                    onPointerUp={end as any}
                  />
                  <text class="svg-label" x={x + w / 2} y={y + h / 2} text-anchor="middle" dominant-baseline="central" style={{ fontSize: api.px(12), strokeWidth: api.px(3), pointerEvents: 'none' }}>
                    {p.label(o)}
                  </text>
                  {sel &&
                    ([['tl', x, y], ['tr', x + w, y], ['br', x + w, y + h], ['bl', x, y + h]] as const).map(([m, hx, hy]) => (
                      <g key={m}>
                        <circle class="handle" cx={hx} cy={hy} r={hr} style={{ strokeWidth: api.px(2) }} />
                        <circle cx={hx} cy={hy} r={api.px(22)} fill="transparent" onPointerDown={start(o.id, m) as any} onPointerMove={move as any} onPointerUp={end as any} />
                      </g>
                    ))}
                </g>
              );
            })}
          </>
        );
      }}
    </PhotoStage>
  );
}

/** Evenly spaced grid of openings centred inside a frame, leaving `inset` for the molding. */
export function gridOpenings(wIn: number, hIn: number, rows: number, cols: number, ow: number, oh: number, inset = 0): Opening[] {
  const iw = wIn - inset * 2, ih = hIn - inset * 2;
  const gx = (iw - cols * ow) / (cols + 1);
  const gy = (ih - rows * oh) / (rows + 1);
  const out: Opening[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      out.push({ id: `o${r * cols + c + 1}`, x: inset + gx + c * (ow + gx), y: inset + gy + r * (oh + gy), w: ow, h: oh, shape: 'rect' });
  return out;
}
