import { COLOR_ORDER } from '../lib/detect';
import type { Frame, Picture } from '../lib/types';
import { SIZE_LABEL } from '../lib/units';
import { COLOR_SWATCH } from '../screens/FrameEditor';
import { Icon } from './Icon';

export interface FrameFilter {
  q: string;
  shape: string[];
  color: string[];
  size: string[];
  matted: 'any' | 'yes' | 'no';
  tags: string[];
  sort: 'size' | 'size-asc' | 'color' | 'newest' | 'name';
  placement: 'any' | 'placed' | 'unplaced';
}

export const emptyFrameFilter: FrameFilter = { q: '', shape: [], color: [], size: [], matted: 'any', tags: [], sort: 'size', placement: 'any' };

/** `isPlaced` decides what "placed" means where the filter is used (any wall, or this layout). */
export function filterFrames(frames: Frame[], f: FrameFilter, isPlaced?: (fr: Frame) => boolean): Frame[] {
  const q = f.q.trim().toLowerCase();
  const out = frames.filter((fr) => {
    if (q && !`${fr.name} ${fr.tags.custom.join(' ')} ${fr.tags.color} ${fr.tags.shape} ${fr.widthIn}x${fr.heightIn}`.toLowerCase().includes(q)) return false;
    if (f.shape.length && !f.shape.includes(fr.tags.shape)) return false;
    if (f.color.length && !f.color.includes(fr.tags.color)) return false;
    if (f.size.length && !f.size.includes(fr.tags.size)) return false;
    if (f.matted === 'yes' && !fr.tags.matted) return false;
    if (f.matted === 'no' && fr.tags.matted) return false;
    if (f.tags.length && !f.tags.every((t) => fr.tags.custom.includes(t))) return false;
    if (isPlaced && f.placement !== 'any' && isPlaced(fr) !== (f.placement === 'placed')) return false;
    return true;
  });
  const area = (x: Frame) => x.widthIn * x.heightIn;
  const cmp: Record<FrameFilter['sort'], (a: Frame, b: Frame) => number> = {
    size: (a, b) => area(b) - area(a),
    'size-asc': (a, b) => area(a) - area(b),
    color: (a, b) => COLOR_ORDER.indexOf(a.tags.color) - COLOR_ORDER.indexOf(b.tags.color) || area(b) - area(a),
    newest: (a, b) => b.createdAt - a.createdAt,
    name: (a, b) => a.name.localeCompare(b.name),
  };
  return out.sort(cmp[f.sort]);
}

function toggle(list: string[], v: string) {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

export function FrameFilterBar({ frames, value, onChange, compact, placementLabels }: { frames: Frame[]; value: FrameFilter; onChange: (f: FrameFilter) => void; compact?: boolean; placementLabels?: [string, string] }) {
  const colors = COLOR_ORDER.filter((c) => frames.some((f) => f.tags.color === c));
  const tags = [...new Set(frames.flatMap((f) => f.tags.custom))].sort();
  const active = value.shape.length + value.color.length + value.size.length + value.tags.length + (value.matted !== 'any' ? 1 : 0) + (value.placement !== 'any' ? 1 : 0);
  return (
    <div class="col" style={{ gap: 8 }}>
      <div class="row">
        <div class="row grow" style={{ position: 'relative' }}>
          <input class="input" placeholder="Search frames" value={value.q} onInput={(e) => onChange({ ...value, q: (e.target as HTMLInputElement).value })} style={{ paddingLeft: 38, minHeight: compact ? 38 : 44 }} />
          <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', opacity: 0.5 }}><Icon name="search" size={18} /></span>
        </div>
        <select class="input" style={{ width: 'auto', minHeight: compact ? 38 : 44, fontSize: 14 }} value={value.sort} onChange={(e) => onChange({ ...value, sort: (e.target as HTMLSelectElement).value as FrameFilter['sort'] })}>
          <option value="size">Largest first</option>
          <option value="size-asc">Smallest first</option>
          <option value="color">By color</option>
          <option value="newest">Newest</option>
          <option value="name">Name</option>
        </select>
        {active > 0 && <button class="btn small" onClick={() => onChange({ ...emptyFrameFilter, q: value.q, sort: value.sort })}>Clear {active}</button>}
      </div>
      {placementLabels && (
        <div class="segmented" style={{ alignSelf: 'flex-start' }}>
          <button class={value.placement === 'any' ? 'on' : ''} onClick={() => onChange({ ...value, placement: 'any' })}>All</button>
          <button class={value.placement === 'unplaced' ? 'on' : ''} data-testid="filter-unplaced" onClick={() => onChange({ ...value, placement: 'unplaced' })}>{placementLabels[1]}</button>
          <button class={value.placement === 'placed' ? 'on' : ''} data-testid="filter-placed" onClick={() => onChange({ ...value, placement: 'placed' })}>{placementLabels[0]}</button>
        </div>
      )}
      <div class={`chips ${compact ? 'scroll' : ''}`}>
        {(['S', 'M', 'L', 'XL'] as const).map((s) => (
          <button key={s} class={`chip ${value.size.includes(s) ? 'on' : ''}`} onClick={() => onChange({ ...value, size: toggle(value.size, s) })}>{SIZE_LABEL[s]}</button>
        ))}
        {(['rectangular', 'circular/oval', 'irregular'] as const).map((s) => (
          <button key={s} class={`chip ${value.shape.includes(s) ? 'on' : ''}`} onClick={() => onChange({ ...value, shape: toggle(value.shape, s) })}>{s}</button>
        ))}
        <button class={`chip ${value.matted === 'yes' ? 'on' : ''}`} onClick={() => onChange({ ...value, matted: value.matted === 'yes' ? 'any' : 'yes' })}>Matted</button>
        <button class={`chip ${value.matted === 'no' ? 'on' : ''}`} onClick={() => onChange({ ...value, matted: value.matted === 'no' ? 'any' : 'no' })}>No mat</button>
      </div>
      {(colors.length > 1 || tags.length > 0) && (
        <div class={`chips ${compact ? 'scroll' : ''}`}>
          {colors.map((c) => (
            <button key={c} class={`chip ${value.color.includes(c) ? 'on' : ''}`} onClick={() => onChange({ ...value, color: toggle(value.color, c) })}>
              <span class="dot" style={{ background: COLOR_SWATCH[c] }} />{c}
            </button>
          ))}
          {tags.map((t) => (
            <button key={t} class={`chip ${value.tags.includes(t) ? 'on' : ''}`} onClick={() => onChange({ ...value, tags: toggle(value.tags, t) })}>
              <Icon name="tag" size={12} /> {t}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export interface PictureFilter { q: string; orientation: string[]; color: string[]; tags: string[]; sort: 'newest' | 'name' | 'color'; usage: 'any' | 'used' | 'unused' }
export const emptyPictureFilter: PictureFilter = { q: '', orientation: [], color: [], tags: [], sort: 'newest', usage: 'any' };

export function filterPictures(pics: Picture[], f: PictureFilter, isUsed?: (p: Picture) => boolean): Picture[] {
  const q = f.q.trim().toLowerCase();
  const out = pics.filter((p) => {
    if (q && !`${p.name} ${p.tags.custom.join(' ')} ${p.tags.color}`.toLowerCase().includes(q)) return false;
    if (f.orientation.length && !f.orientation.includes(p.tags.orientation)) return false;
    if (f.color.length && !f.color.includes(p.tags.color)) return false;
    if (f.tags.length && !f.tags.every((t) => p.tags.custom.includes(t))) return false;
    if (isUsed && f.usage !== 'any' && isUsed(p) !== (f.usage === 'used')) return false;
    return true;
  });
  if (f.sort === 'name') out.sort((a, b) => a.name.localeCompare(b.name));
  else if (f.sort === 'color') out.sort((a, b) => COLOR_ORDER.indexOf(a.tags.color) - COLOR_ORDER.indexOf(b.tags.color));
  else out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

export function PictureFilterBar({ pictures, value, onChange, compact, usageLabels }: { pictures: Picture[]; value: PictureFilter; onChange: (f: PictureFilter) => void; compact?: boolean; usageLabels?: [string, string] }) {
  const colors = COLOR_ORDER.filter((c) => pictures.some((p) => p.tags.color === c));
  const tags = [...new Set(pictures.flatMap((p) => p.tags.custom))].sort();
  return (
    <div class="col" style={{ gap: 8 }}>
      <div class="row">
        <input class="input" placeholder="Search pictures" value={value.q} onInput={(e) => onChange({ ...value, q: (e.target as HTMLInputElement).value })} style={{ minHeight: compact ? 38 : 44 }} />
        <select class="input" style={{ width: 'auto', minHeight: compact ? 38 : 44, fontSize: 14 }} value={value.sort} onChange={(e) => onChange({ ...value, sort: (e.target as HTMLSelectElement).value as PictureFilter['sort'] })}>
          <option value="newest">Newest</option>
          <option value="color">By color</option>
          <option value="name">Name</option>
        </select>
      </div>
      {usageLabels && (
        <div class="segmented" style={{ alignSelf: 'flex-start' }}>
          <button class={value.usage === 'any' ? 'on' : ''} onClick={() => onChange({ ...value, usage: 'any' })}>All</button>
          <button class={value.usage === 'unused' ? 'on' : ''} onClick={() => onChange({ ...value, usage: 'unused' })}>{usageLabels[1]}</button>
          <button class={value.usage === 'used' ? 'on' : ''} onClick={() => onChange({ ...value, usage: 'used' })}>{usageLabels[0]}</button>
        </div>
      )}
      <div class={`chips ${compact ? 'scroll' : ''}`}>
        {(['portrait', 'landscape', 'square'] as const).map((o) => (
          <button key={o} class={`chip ${value.orientation.includes(o) ? 'on' : ''}`} onClick={() => onChange({ ...value, orientation: toggle(value.orientation, o) })}>{o}</button>
        ))}
        {colors.map((c) => (
          <button key={c} class={`chip ${value.color.includes(c) ? 'on' : ''}`} onClick={() => onChange({ ...value, color: toggle(value.color, c) })}>
            <span class="dot" style={{ background: COLOR_SWATCH[c] }} />{c}
          </button>
        ))}
        {tags.map((t) => (
          <button key={t} class={`chip ${value.tags.includes(t) ? 'on' : ''}`} onClick={() => onChange({ ...value, tags: toggle(value.tags, t) })}><Icon name="tag" size={12} /> {t}</button>
        ))}
      </div>
    </div>
  );
}
