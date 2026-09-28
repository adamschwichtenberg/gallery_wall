import { useState } from 'preact/hooks';
import { emptyFrameFilter, emptyPictureFilter, filterFrames, filterPictures, FrameFilterBar, PictureFilterBar, type FrameFilter, type PictureFilter } from '../components/Filters';
import { FrameThumb } from '../components/FrameArt';
import { Icon } from '../components/Icon';
import { useBlobUrl } from '../components/ui';
import { openModal, useStore } from '../lib/store';
import type { Frame, Picture } from '../lib/types';
import { fmtSize, SIZE_LABEL } from '../lib/units';
import { COLOR_SWATCH } from './FrameEditor';

export function FramesScreen() {
  const frames = useStore((s) => s.frames);
  const units = useStore((s) => s.prefs.units);
  const [filter, setFilter] = useState<FrameFilter>(emptyFrameFilter);
  const list = filterFrames(frames, filter);
  const total = frames.reduce((a, f) => a + f.qty, 0);
  return (
    <div class="screen">
      <div class="page-head">
        <div>
          <h1>Frames</h1>
          <div class="muted">{total} frame{total === 1 ? '' : 's'} in your inventory</div>
        </div>
        <button class="btn primary" data-testid="add-frame" onClick={() => openModal({ kind: 'frame' })}><Icon name="plus" /> Add frame</button>
      </div>
      {frames.length > 0 && (
        <div class="filterbar glass">
          <FrameFilterBar frames={frames} value={filter} onChange={setFilter} />
        </div>
      )}
      {frames.length === 0 ? (
        <div class="empty glass" style={{ borderRadius: 26 }}>
          <Icon name="frame" size={44} />
          <h2>No frames yet</h2>
          <div class="hint" style={{ maxWidth: 420 }}>Photograph each frame on the floor, enter its outside size, and it’s cut out automatically, with sizes, colors and tags filled in for you.</div>
          <button class="btn primary" onClick={() => openModal({ kind: 'frame' })}><Icon name="camera" /> Add your first frame</button>
        </div>
      ) : (
        <div class="card-grid">
          {list.map((f) => <FrameCard key={f.id} frame={f} units={units} />)}
          <button class="card add" onClick={() => openModal({ kind: 'frame' })}><Icon name="plus" size={30} /> Add frame</button>
        </div>
      )}
      {frames.length > 0 && list.length === 0 && <div class="empty">No frames match these filters.</div>}
    </div>
  );
}

function FrameCard({ frame, units }: { frame: Frame; units: 'in' | 'cm' }) {
  return (
    <div class="card glass" data-testid="frame-card" onClick={() => openModal({ kind: 'frame', id: frame.id })}>
      <div class="thumb"><FrameThumb frame={frame} box={165} /></div>
      {frame.qty > 1 && <span class="badge">×{frame.qty}</span>}
      <div class="size">{fmtSize(frame.widthIn, frame.heightIn, units)}</div>
      <div class="name">{frame.name}</div>
      <div class="tagline">
        <span><i class="dot" style={{ background: frame.tags.colorHex || COLOR_SWATCH[frame.tags.color] }} />{frame.tags.color}</span>
        <span>{SIZE_LABEL[frame.tags.size]}</span>
        {frame.tags.shape !== 'rectangular' && <span>{frame.tags.shape}</span>}
        {frame.tags.matted && <span>matted</span>}
        {frame.openings.length > 1 && <span>{frame.openings.length} openings</span>}
        {frame.tags.custom.map((t) => <span key={t}>{t}</span>)}
      </div>
    </div>
  );
}

export function PicturesScreen() {
  const pictures = useStore((s) => s.pictures);
  const [filter, setFilter] = useState<PictureFilter>(emptyPictureFilter);
  const list = filterPictures(pictures, filter);
  return (
    <div class="screen">
      <div class="page-head">
        <div>
          <h1>Pictures</h1>
          <div class="muted">Photos and prints you can swap into any frame</div>
        </div>
        <button class="btn primary" data-testid="add-picture" onClick={() => openModal({ kind: 'picture' })}><Icon name="plus" /> Add picture</button>
      </div>
      {pictures.length > 0 && (
        <div class="filterbar glass"><PictureFilterBar pictures={pictures} value={filter} onChange={setFilter} /></div>
      )}
      {pictures.length === 0 ? (
        <div class="empty glass" style={{ borderRadius: 26 }}>
          <Icon name="picture" size={44} />
          <h2>No pictures yet</h2>
          <div class="hint" style={{ maxWidth: 420 }}>Add photos from your library (or photograph prints) to try them inside your frames on the wall.</div>
          <button class="btn primary" onClick={() => openModal({ kind: 'picture' })}><Icon name="photos" /> Add a picture</button>
        </div>
      ) : (
        <div class="card-grid">
          {list.map((p) => <PictureCard key={p.id} picture={p} />)}
          <button class="card add" onClick={() => openModal({ kind: 'picture' })}><Icon name="plus" size={30} /> Add picture</button>
        </div>
      )}
    </div>
  );
}

function PictureCard({ picture }: { picture: Picture }) {
  const url = useBlobUrl(picture.imageBlobId);
  return (
    <div class="card glass" onClick={() => openModal({ kind: 'picture', id: picture.id })}>
      <div class="thumb">{url && <img src={url} />}</div>
      <div class="name" style={{ fontSize: 15, color: 'var(--text)', fontWeight: 600 }}>{picture.name}</div>
      <div class="tagline">
        <span><i class="dot" style={{ background: picture.tags.colorHex }} />{picture.tags.color}</span>
        <span>{picture.tags.orientation}</span>
        {picture.tags.custom.map((t) => <span key={t}>{t}</span>)}
      </div>
    </div>
  );
}
