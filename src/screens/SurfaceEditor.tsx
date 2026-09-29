// Outline a ceiling, baseboard, trim, custom area or no-paint area with points on the photo.
import { useState } from 'preact/hooks';
import { PolygonPins } from '../components/PolygonPins';
import { Icon } from '../components/Icon';
import { useBlobUrl, useImgSize } from '../components/ui';
import { SURFACE_LABEL } from '../lib/paintwall';
import { getProject, openModal, saveProject, useStore } from '../lib/store';
import type { Pt, SurfaceKind } from '../lib/types';

const HINTS: Record<SurfaceKind, string> = {
  ceiling: 'Put the bottom two points on the line where the wall meets the ceiling, and the top two above it. Everything inside that looks like ceiling will be painted.',
  baseboard: 'Put the bottom two points where the baseboard meets the floor, and the top two along its top edge.',
  trim: 'Surround the trim or molding — detection stays inside the outline. Add points to follow corners.',
  area: 'Surround the area to paint separately (an accent section, a second wall…).',
  exclude: 'Surround anything that must stay exactly as photographed. Nothing inside is painted.',
};

export function SurfaceEditor({ projectId, id }: { projectId: string; id: string }) {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  const wall = project?.wall;
  const surface = wall?.surfaces?.find((s) => s.id === id);
  const [quad, setQuad] = useState<Pt[] | undefined>(surface?.quad);
  const [name, setName] = useState(surface?.name ?? '');
  const url = useBlobUrl(wall?.sourceBlobId);
  const size = useImgSize(url);
  if (!wall || !surface || !quad) return null;
  const close = () => openModal(null);
  const save = async () => {
    const p = getProject(projectId)!;
    const surfaces = (p.wall!.surfaces ?? []).map((s) => (s.id === id ? { ...s, quad, name: name.trim() || s.name } : s));
    await saveProject({ ...p, wall: { ...p.wall!, surfaces } }, false);
    close();
  };
  return (
    <div class="fullscreen-editor">
      <div class="editor-body">
        {size ? (
          <PolygonPins
            src={url}
            imgW={size.w}
            imgH={size.h}
            pts={quad}
            onChange={setQuad}
            under={(api) => (
              <>
                {(wall.surfaces ?? []).filter((s) => s.id !== id).map((s) => (
                  <polygon key={s.id} points={s.quad.map((p) => `${p.x},${p.y}`).join(' ')} fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.4)" stroke-width={api.px(1)} stroke-dasharray={`${api.px(5)} ${api.px(4)}`} />
                ))}
              </>
            )}
          />
        ) : (
          <div class="editor-stage" style={{ display: 'grid', placeItems: 'center' }}><div class="spinner" /></div>
        )}
        <div class="editor-side">
          <div class="panel glass strong grow">
            <h2>{SURFACE_LABEL[surface.kind]}</h2>
            <div class="hint">{HINTS[surface.kind]}</div>
            <div class="hint"><b>Drag</b> points to move them. <b>Tap an edge</b> to add a point there (for angled or L-shaped areas); <b>double-tap</b> a point to remove it. Pinch to zoom for precision.</div>
            <div class="faint small-text">{quad.length} points · dashed outlines are your other areas.</div>
            <label class="field"><span>Name</span><input class="input" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} /></label>
          </div>
          <div class="row">
            <button class="btn" onClick={close}>Cancel</button>
            <div class="grow" />
            <button class="btn primary" data-testid="save-surface" onClick={save}><Icon name="check" /> Done</button>
          </div>
        </div>
      </div>
      <div class="editor-head">
        <button class="btn icon-only glass" onClick={close} aria-label="Close"><Icon name="close" /></button>
        <div class="toolbar glass" style={{ padding: '6px 16px', fontWeight: 600 }}>Outline: {name || SURFACE_LABEL[surface.kind]}</div>
      </div>
    </div>
  );
}
