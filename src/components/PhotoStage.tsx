// A zoomable photo with an SVG overlay drawn in image coordinates.
// One finger on the background pans (unless disabled), two fingers pinch-zoom, wheel/trackpad zooms.
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Pt } from '../lib/types';

export interface View { s: number; tx: number; ty: number }

export interface StageApi {
  view: View;
  toImage: (clientX: number, clientY: number) => Pt;
  /** Screen pixels → image pixels at the current zoom. */
  px: (screenPx: number) => number;
}

interface Props {
  src: string | undefined;
  imgW: number;
  imgH: number;
  children?: (api: StageApi) => ComponentChildren;
  /** Rendered above the SVG (HTML overlays positioned in screen space). */
  html?: (api: StageApi) => ComponentChildren;
  onBackgroundDown?: (e: PointerEvent, api: StageApi) => boolean | void; // return true to claim the gesture
  onBackgroundMove?: (e: PointerEvent, api: StageApi) => void;
  onBackgroundUp?: (e: PointerEvent, api: StageApi) => void;
  loupe?: Pt | null;
  padding?: number;
  checker?: boolean;
  /** Re-fit when this changes. */
  fitKey?: unknown;
}

export function PhotoStage(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ s: 1, tx: 0, ty: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const pointers = useRef(new Map<number, Pt>());
  const gesture = useRef<{ kind: 'pan' | 'pinch' | 'claimed'; start: View; p0: Pt; d0?: number; c0?: Pt } | null>(null);
  const imgEl = useRef<HTMLImageElement>(null);

  const fit = () => {
    const el = host.current;
    if (!el || !props.imgW) return;
    const r = el.getBoundingClientRect();
    const pad = props.padding ?? 40;
    const s = Math.min((r.width - pad * 2) / props.imgW, (r.height - pad * 2) / props.imgH);
    setView({ s, tx: (r.width - props.imgW * s) / 2, ty: (r.height - props.imgH * s) / 2 });
  };
  useLayoutEffect(fit, [props.imgW, props.imgH, props.fitKey]);
  useEffect(() => {
    const ro = new ResizeObserver(() => fit());
    if (host.current) ro.observe(host.current);
    return () => ro.disconnect();
  }, [props.imgW, props.imgH]);

  const api: StageApi = {
    view,
    toImage: (cx, cy) => {
      const r = host.current!.getBoundingClientRect();
      const v = viewRef.current;
      return { x: (cx - r.left - v.tx) / v.s, y: (cy - r.top - v.ty) / v.s };
    },
    px: (n) => n / viewRef.current.s,
  };

  const local = (e: PointerEvent): Pt => {
    const r = host.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onDown = (e: PointerEvent) => {
    pointers.current.set(e.pointerId, local(e));
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { kind: 'pinch', start: viewRef.current, p0: a, d0: Math.hypot(a.x - b.x, a.y - b.y), c0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
      return;
    }
    if (props.onBackgroundDown?.(e, api)) {
      gesture.current = { kind: 'claimed', start: viewRef.current, p0: local(e) };
      return;
    }
    gesture.current = { kind: 'pan', start: viewRef.current, p0: local(e) };
  };
  const onMove = (e: PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, local(e));
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'claimed') return props.onBackgroundMove?.(e, api);
    if (g.kind === 'pan') {
      const p = local(e);
      setView({ ...g.start, tx: g.start.tx + p.x - g.p0.x, ty: g.start.ty + p.y - g.p0.y });
    } else if (g.kind === 'pinch' && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const s = clampScale(g.start.s * (d / g.d0!));
      const k = s / g.start.s;
      setView({ s, tx: c.x - (g.c0!.x - g.start.tx) * k, ty: c.y - (g.c0!.y - g.start.ty) * k });
    }
  };
  const onUp = (e: PointerEvent) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (g?.kind === 'claimed') props.onBackgroundUp?.(e, api);
    if (pointers.current.size === 0) gesture.current = null;
    else if (g?.kind === 'pinch') {
      const [p] = [...pointers.current.values()];
      gesture.current = { kind: 'pan', start: viewRef.current, p0: p };
    }
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = local(e as unknown as PointerEvent);
    const v = viewRef.current;
    if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > 40 && !e.deltaX) {
      const s = clampScale(v.s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)));
      const k = s / v.s;
      setView({ s, tx: p.x - (p.x - v.tx) * k, ty: p.y - (p.y - v.ty) * k });
    } else {
      setView({ ...v, tx: v.tx - e.deltaX, ty: v.ty - e.deltaY });
    }
  };
  useEffect(() => {
    const el = host.current!;
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  const clampScale = (s: number) => {
    const el = host.current;
    const base = el ? Math.min(el.clientWidth / Math.max(1, props.imgW), el.clientHeight / Math.max(1, props.imgH)) : 1;
    return Math.max(base * 0.3, Math.min(base * 24, s));
  };

  return (
    <div
      ref={host}
      class="editor-stage"
      onPointerDown={onDown as any}
      onPointerMove={onMove as any}
      onPointerUp={onUp as any}
      onPointerCancel={onUp as any}
      style={props.checker ? { background: 'repeating-conic-gradient(#1a1a20 0% 25%, #121216 0% 50%) 50% / 24px 24px' } : undefined}
    >
      {props.src && (
        <img
          ref={imgEl}
          class="stage-img"
          src={props.src}
          style={{ width: props.imgW, height: props.imgH, transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.s})` }}
          draggable={false}
        />
      )}
      <svg class="stage-svg">
        <g transform={`translate(${view.tx} ${view.ty}) scale(${view.s})`}>{props.children?.(api)}</g>
      </svg>
      {props.html?.(api)}
      {props.loupe && props.src && <Loupe src={imgEl.current} at={props.loupe} view={view} hostW={host.current?.clientWidth ?? 0} />}
    </div>
  );
}

/** Magnifier shown while dragging a point so the finger doesn't hide the target. */
function Loupe({ src, at, view, hostW }: { src: HTMLImageElement | null; at: Pt; view: View; hostW: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const size = 132, zoom = 3;
  useEffect(() => {
    const c = ref.current;
    if (!c || !src || !src.naturalWidth) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = size * dpr;
    c.height = size * dpr;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, c.width, c.height);
    // Source pixels per displayed image unit.
    const k = src.naturalWidth / parseFloat(src.style.width || String(src.naturalWidth));
    const span = size / (view.s * zoom); // image units visible across the loupe
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, (at.x - span / 2) * k, (at.y - span / 2) * k, span * k, span * k, 0, 0, c.width, c.height);
  });
  const sx = at.x * view.s + view.tx, sy = at.y * view.s + view.ty;
  // Float above-left of the finger; flip to the right near the left edge.
  let left = sx - size - 28;
  if (left < 8) left = Math.min(sx + 28, hostW - size - 8);
  const top = Math.max(8, sy - size - 36);
  return (
    <div class="loupe" style={{ left, top }}>
      <canvas ref={ref} />
    </div>
  );
}
