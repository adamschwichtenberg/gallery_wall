import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { blobUrl, cachedBlobUrl } from '../lib/db';
import { useStore } from '../lib/store';
import { fmtLen, parseLen, toInputText } from '../lib/units';
import { Icon } from './Icon';

/** Resolve a stored blob id to an object URL. */
export function useBlobUrl(id: string | undefined): string | undefined {
  const [url, setUrl] = useState<string | undefined>(() => cachedBlobUrl(id));
  useEffect(() => {
    let alive = true;
    setUrl(cachedBlobUrl(id));
    blobUrl(id).then((u) => alive && setUrl(u));
    return () => { alive = false; };
  }, [id]);
  return url;
}

/** A length field that understands fractions (14 1/4, 14¼, 14.25) and cm. */
export function LengthInput(props: { value: number; onChange: (inches: number) => void; label?: string; big?: boolean; min?: number; placeholder?: string }) {
  const units = useStore((s) => s.prefs.units);
  const [text, setText] = useState(isFinite(props.value) && props.value ? toInputText(props.value, units) : '');
  const [bad, setBad] = useState(false);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(isFinite(props.value) && props.value ? toInputText(props.value, units) : '');
  }, [props.value, units]);
  const commit = (t: string) => {
    const v = parseLen(t, units);
    const ok = isFinite(v) && v >= (props.min ?? 0);
    setBad(!ok && t.trim() !== '');
    if (ok) props.onChange(v);
  };
  const input = (
    <div class="row" style={{ gap: 6 }}>
      <input
        class={`input ${props.big ? 'big' : ''}`}
        style={bad ? { boxShadow: 'inset 0 0 0 2px var(--danger)' } : undefined}
        inputMode="text"
        enterKeyHint="done"
        placeholder={props.placeholder ?? (units === 'cm' ? 'cm' : 'e.g. 11 1/4')}
        value={text}
        onFocus={() => (focused.current = true)}
        onInput={(e) => {
          const t = (e.target as HTMLInputElement).value;
          setText(t);
          commit(t);
        }}
        onBlur={() => {
          focused.current = false;
          if (isFinite(props.value) && props.value) setText(toInputText(props.value, units));
        }}
      />
      <span class="faint" style={{ minWidth: 22 }}>{units === 'cm' ? 'cm' : 'in'}</span>
    </div>
  );
  if (!props.label) return input;
  return (
    <label class="field">
      <span>{props.label}</span>
      {input}
    </label>
  );
}

export function Len({ v }: { v: number }) {
  const units = useStore((s) => s.prefs.units);
  return <>{fmtLen(v, units)}</>;
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  const t = <button class={`toggle ${on ? 'on' : ''}`} role="switch" aria-checked={on} onClick={() => onChange(!on)} />;
  if (!label) return t;
  return (
    <div class="row" style={{ justifyContent: 'space-between' }}>
      <span style={{ fontSize: 15 }}>{label}</span>
      {t}
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ComponentChildren }[]; onChange: (v: T) => void }) {
  return (
    <div class="segmented">
      {options.map((o) => (
        <button key={o.value} class={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({ children, onClose, width }: { children: ComponentChildren; onClose: () => void; width?: number }) {
  return (
    <div class="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal glass strong" style={width ? { width: `min(${width}px, calc(100vw - 32px))` } : undefined}>
        {children}
      </div>
    </div>
  );
}

export function Busy({ text }: { text: string }) {
  return (
    <div class="busy">
      <div class="glass strong">
        <div class="spinner" />
        <span>{text}</span>
      </div>
    </div>
  );
}

/** Two big buttons: camera capture and photo library / files. */
export function PhotoSource({ onFile, title, hint }: { onFile: (f: File) => void; title: string; hint: ComponentChildren }) {
  const cam = useRef<HTMLInputElement>(null);
  const lib = useRef<HTMLInputElement>(null);
  const pick = (e: Event) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    (e.target as HTMLInputElement).value = '';
    if (f) onFile(f);
  };
  return (
    <div class="empty" style={{ height: '100%', justifyContent: 'center' }}>
      <h2>{title}</h2>
      <div class="hint" style={{ maxWidth: 440 }}>{hint}</div>
      <div class="row wrap" style={{ justifyContent: 'center', marginTop: 8 }}>
        <button class="btn primary" style={{ minHeight: 56, padding: '0 26px', fontSize: 17 }} onClick={() => cam.current?.click()}>
          <Icon name="camera" size={22} /> Take photo
        </button>
        <button class="btn" style={{ minHeight: 56, padding: '0 26px', fontSize: 17 }} onClick={() => lib.current?.click()}>
          <Icon name="photos" size={22} /> Choose photo
        </button>
      </div>
      <input ref={cam} type="file" accept="image/*" capture="environment" hidden onChange={pick} data-testid="camera-input" />
      <input ref={lib} type="file" accept="image/*" hidden onChange={pick} data-testid="library-input" />
    </div>
  );
}

export function Steps({ steps, current, onGo, maxReached }: { steps: string[]; current: number; onGo: (i: number) => void; maxReached: number }) {
  return (
    <div class="steps glass">
      {steps.map((s, i) => (
        <button key={s} class={`${i === current ? 'on' : ''} ${i < maxReached ? 'done' : ''}`} disabled={i > maxReached} onClick={() => onGo(i)}>
          <span class="n">{i < maxReached && i !== current ? '✓' : i + 1}</span>
          <span class="lbl">{s}</span>
        </button>
      ))}
    </div>
  );
}

export function confirmAsync(msg: string) {
  return Promise.resolve(window.confirm(msg));
}
