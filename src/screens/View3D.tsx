// Full-screen 3D walk-around of the wall, plus the AR hand-off.
import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon } from '../components/Icon';
import { Busy, useBlobUrl } from '../components/ui';
import { shareOrDownload } from '../lib/backup';
import { ceilingHeightOf } from '../lib/paintwall';
import { toast } from '../lib/store';
import type { Frame, Layout, Picture, Project } from '../lib/types';
import { wallGeometry } from './Arrange';

type Scene3d = typeof import('../lib/scene3d');

const VANTAGES: { id: import('../lib/scene3d').Vantage; label: string }[] = [
  { id: 'front', label: 'Straight on' },
  { id: 'left', label: 'From the left' },
  { id: 'right', label: 'From the right' },
  { id: 'close', label: 'Up close' },
  { id: 'seated', label: 'Seated' },
  { id: 'far', label: 'Across the room' },
];

export function View3D({ project, layout, frames, pictures, onClose }: { project: Project; layout: Layout; frames: Map<string, Frame>; pictures: Map<string, Picture>; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<import('../lib/scene3d').WallViewer | null>(null);
  const [busy, setBusy] = useState<string | null>('Building 3D view…');
  const [active, setActive] = useState<string>('front');
  const wall = project.wall;
  const wallUrl = useBlobUrl(wall ? (project.settings.showPaint && wall.paintedBlobId) || wall.imageBlobId : undefined);

  useEffect(() => {
    if (wall && !wallUrl) return;
    let dead = false;
    (async () => {
      try {
        const m: Scene3d = await import('../lib/scene3d');
        const gallery = await m.buildGallery(layout.items, frames, pictures, 1024);
        if (dead || !host.current) return;
        const g = wallGeometry(project);
        viewer.current = new m.WallViewer(host.current, {
          wallUrl, x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1, floorY: g.floorY,
          ceilingY: wall && ceilingHeightOf(wall) ? g.floorY - ceilingHeightOf(wall)! : undefined,
          gallery,
        });
      } catch (e) {
        toast(`3D view failed: ${(e as Error).message}`);
      } finally {
        setBusy(null);
      }
    })();
    return () => {
      dead = true;
      viewer.current?.dispose();
      viewer.current = null;
    };
  }, [wallUrl]);

  return (
    <div class="fullscreen-editor" style={{ zIndex: 45 }}>
      <div ref={host} class="three-host" data-testid="three-host" />
      <div class="editor-head">
        <button class="btn icon-only glass strong" onClick={onClose} aria-label="Close 3D view"><Icon name="close" /></button>
        <div class="toolbar glass strong" style={{ flexWrap: 'wrap' }}>
          {VANTAGES.map((v) => (
            <button key={v.id} class={`btn small ghost ${active === v.id ? 'on' : ''}`} onClick={() => { setActive(v.id); viewer.current?.goTo(v.id); }}>{v.label}</button>
          ))}
        </div>
      </div>
      <div class="hud-bottom toolbar glass strong">
        <ArButton project={project} layout={layout} frames={frames} pictures={pictures} />
        <div class="sep" />
        <button class="btn ghost" onClick={async () => { const b = await viewer.current?.snapshot(); if (b) await shareOrDownload(b, `${project.name} - 3D.png`); }}>
          <Icon name="camera" /> <span class="lbl-sm">Save view</span>
        </button>
      </div>
      <div class="three-hint glass strong">Drag to look around · pinch to walk closer · two fingers to slide</div>
      {busy && <Busy text={busy} />}
    </div>
  );
}

/** "View in AR" on iPhone/iPad (AR Quick Look); elsewhere, save the .usdz to AirDrop to one. */
export function ArButton({ project, layout, frames, pictures, full }: { project: Project; layout: Layout; frames: Map<string, Frame>; pictures: Map<string, Picture>; full?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    const a = document.createElement('a');
    setSupported(!!a.relList?.supports?.('ar'));
  }, []);
  const build = async () => {
    const m: Scene3d = await import('../lib/scene3d');
    const g = await m.buildGallery(layout.items, frames, pictures, 1024);
    return m.exportUSDZ(g);
  };
  const empty = !layout.items.some((i) => frames.has(i.frameId));
  const name = `${project.name} - ${layout.name}.usdz`;
  return (
    <>
      {supported && (
        <button class={`btn ${full ? 'primary' : 'ghost'}`} disabled={busy || empty} data-testid="view-ar" onClick={async () => {
          setBusy(true);
          try {
            const m: Scene3d = await import('../lib/scene3d');
            m.openQuickLook(await build());
          } catch (e) { toast(`AR failed: ${(e as Error).message}`); } finally { setBusy(false); }
        }}>
          <Icon name="cube" /> <span class={full ? '' : 'lbl-sm'}>{busy ? 'Preparing…' : 'View in AR'}</span>
        </button>
      )}
      <button class={`btn ${full && !supported ? 'primary' : full ? '' : 'ghost'}`} disabled={busy || empty} data-testid="share-ar" onClick={async () => {
        setBusy(true);
        try { await shareOrDownload(await build(), name); } catch (e) { toast(`Couldn’t build the AR model: ${(e as Error).message}`); } finally { setBusy(false); }
      }}>
        <Icon name="share" /> <span class={full ? '' : 'lbl-sm'}>{busy && !supported ? 'Preparing…' : 'Share AR model'}</span>
      </button>
    </>
  );
}
