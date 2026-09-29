// Add another photo of the wall from a different spot in the room. Matching a few reference
// points that appear in both photos (outlet, smoke detector, corners, switch plate) gives the new
// photo's perspective of the wall, so the arrangement can be shown in it.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { FrameArt } from '../components/FrameArt';
import { Icon } from '../components/Icon';
import { PhotoStage } from '../components/PhotoStage';
import { POINT_COLORS, PointPins } from '../components/PointPins';
import { Busy, PhotoSource, Segmented, Steps, useBlobUrl, useImgSize } from '../components/ui';
import { footprint, unionBox } from '../lib/arrange';
import { deleteBlob, putBlob, uid } from '../lib/db';
import { applyH, homographyLSQ, invert3, reprojectionError, type Mat3 } from '../lib/geometry';
import type { Img } from '../lib/imaging';
import { loadSource, loadStoredSource, nextFrame } from '../lib/pipeline';
import { cssMatrix, localScale, multiply3, scaleMat, viewMat, wallToSource } from '../lib/projection';
import { activeLayout, getProject, openModal, saveProject, toast, useStore } from '../lib/store';
import type { Pt, Vantage } from '../lib/types';

const STEPS = ['Photo', 'Match points', 'Check'];

interface Pair { wall: Pt; photo: Pt | null }

export function VantageEditor({ projectId, id }: { projectId: string; id?: string }) {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  const framesList = useStore((s) => s.frames);
  const picturesList = useStore((s) => s.pictures);
  const frames = useMemo(() => new Map(framesList.map((f) => [f.id, f])), [framesList]);
  const pictures = useMemo(() => new Map(picturesList.map((p) => [p.id, p])), [picturesList]);
  const wall = project?.wall;
  const existing = project?.vantages?.find((v) => v.id === id);
  const [step, setStep] = useState(existing ? 1 : 0);
  const [maxStep, setMaxStep] = useState(existing ? 2 : 0);
  const [busy, setBusy] = useState<string | null>(null);
  const [src, setSrc] = useState<{ img: Img; url: string; blob?: Blob; blobId?: string } | null>(null);
  const [pairs, setPairs] = useState<Pair[]>(existing?.points ?? []);
  const [sel, setSel] = useState<number | null>(0);
  const [adding, setAdding] = useState(false);
  const [side, setSide] = useState<'main' | 'new'>('new');
  const [name, setName] = useState(existing?.name ?? `View ${(project?.vantages?.length ?? 0) + 2}`);
  const mainUrl = useBlobUrl(wall?.sourceBlobId);
  const mainSize = useImgSize(mainUrl);
  const narrow = typeof window !== 'undefined' && window.innerWidth < 900;

  useEffect(() => {
    if (!existing) return;
    loadStoredSource(existing.sourceBlobId).then((s) => s && setSrc({ img: s.img, url: s.canvas.toDataURL('image/jpeg', 0.85), blobId: existing.sourceBlobId }));
  }, [existing?.id]);

  if (!project || !wall) return null;
  const Hmain = wallToSource(wall);
  const HmainInv = invert3(Hmain);
  const close = () => openModal(null);

  const complete = pairs.filter((p) => p.photo) as { wall: Pt; photo: Pt }[];
  let H: Mat3 | null = null;
  let err = 0;
  if (complete.length >= 4) {
    try {
      H = homographyLSQ(complete.map((p) => p.wall), complete.map((p) => p.photo));
      err = reprojectionError(H, complete.map((p) => p.wall), complete.map((p) => p.photo));
    } catch {
      H = null;
    }
  }

  /** Best guess of where a wall point appears in the new photo. */
  const guess = (w: Pt): Pt => {
    if (H) return applyH(H, w.x, w.y);
    const m = applyH(Hmain, w.x, w.y);
    return mainSize && src ? { x: (m.x / mainSize.w) * src.img.width, y: (m.y / mainSize.h) * src.img.height } : m;
  };

  const onPhoto = async (file: File) => {
    setBusy('Reading photo…');
    await nextFrame();
    try {
      const s = await loadSource(file);
      setSrc({ img: s.img, url: s.canvas.toDataURL('image/jpeg', 0.85), blob: s.blob });
      // Start with the corners of the rectangle measured in the main photo.
      const corners = [{ x: 0, y: 0 }, { x: wall.refW, y: 0 }, { x: wall.refW, y: wall.refH }, { x: 0, y: wall.refH }];
      const ms = mainSize ?? { w: s.img.width, h: s.img.height };
      setPairs(corners.map((c) => {
        const m = applyH(Hmain, c.x, c.y);
        return { wall: c, photo: { x: (m.x / ms.w) * s.img.width, y: (m.y / ms.h) * s.img.height } };
      }));
      setSel(0);
      go(1);
    } catch (e) {
      toast(String((e as Error).message ?? e));
    } finally {
      setBusy(null);
    }
  };

  const go = (n: number) => {
    if (n === 2 && !H) return toast('Match at least 4 points first');
    setStep(n);
    setMaxStep((m) => Math.max(m, n));
  };

  const save = async () => {
    if (!H || !src) return;
    setBusy('Saving…');
    try {
      let sourceBlobId = src.blobId ?? existing?.sourceBlobId ?? '';
      if (src.blob) sourceBlobId = await putBlob(src.blob);
      const v: Vantage = { id: existing?.id ?? uid(), name: name.trim() || 'View', sourceBlobId, points: complete, H: [...H] };
      if (existing?.paintedBlobId) await deleteBlob(existing.paintedBlobId);
      const p = getProject(projectId)!;
      const list = p.vantages ?? [];
      const vantages = existing ? list.map((x) => (x.id === v.id ? v : x)) : [...list, v];
      await saveProject({ ...p, vantages, settings: { ...p.settings, viewMode: 'vantage', vantageId: v.id } });
      toast('View added — switch views from the top bar');
      close();
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!existing || !confirm(`Remove “${existing.name}”?`)) return;
    const p = getProject(projectId)!;
    await deleteBlob(existing.paintedBlobId);
    const vantages = (p.vantages ?? []).filter((x) => x.id !== existing.id);
    await saveProject({ ...p, vantages, settings: p.settings.vantageId === existing.id ? { ...p.settings, viewMode: 'photo', vantageId: undefined } : p.settings });
    close();
  };

  const mainStage = mainUrl && mainSize && (
    <PointPins
      testid="main"
      src={mainUrl}
      imgW={mainSize.w}
      imgH={mainSize.h}
      pts={pairs.map((p) => applyH(Hmain, p.wall.x, p.wall.y))}
      selected={sel}
      onSelect={setSel}
      onMove={(i, q) => setPairs(pairs.map((p, k) => (k === i ? { ...p, wall: applyH(HmainInv, q.x, q.y) } : p)))}
      onTap={adding ? (q) => {
        const w = applyH(HmainInv, q.x, q.y);
        setPairs([...pairs, { wall: w, photo: guess(w) }]);
        setSel(pairs.length);
        setAdding(false);
        if (narrow) setSide('new');
      } : undefined}
      extra={(api) => <polygon points={wall.quad.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="rgba(255,255,255,0.45)" stroke-width={api.px(1.5)} stroke-dasharray={`${api.px(6)} ${api.px(5)}`} />}
    />
  );
  const newStage = src && (
    <PointPins
      testid="new"
      src={src.url}
      imgW={src.img.width}
      imgH={src.img.height}
      pts={pairs.map((p) => p.photo)}
      selected={sel}
      onSelect={setSel}
      onMove={(i, q) => setPairs(pairs.map((p, k) => (k === i ? { ...p, photo: q } : p)))}
      extra={(api) =>
        H ? (
          <polygon
            points={[[0, 0], [wall.refW, 0], [wall.refW, wall.refH], [0, wall.refH]].map(([x, y]) => { const q = applyH(H!, x, y); return `${q.x},${q.y}`; }).join(' ')}
            fill="rgba(143,184,255,0.1)" stroke="rgba(143,184,255,0.85)" stroke-width={api.px(1.5)}
          />
        ) : null
      }
    />
  );

  return (
    <div class="fullscreen-editor">
      <div class="editor-body">
        {step === 0 && (
          <div class="editor-stage">
            <PhotoSource
              title="Photograph the wall from another spot"
              onFile={onPhoto}
              hint={<>Stand somewhere else in the room — the doorway, the sofa, the far end of the hall — and take a photo that shows the same wall. You’ll match a few points next.</>}
            />
          </div>
        )}
        {step === 1 && (
          <div class="editor-stage" style={{ display: 'flex', gap: 2 }}>
            {(!narrow || side === 'main') && <div style={{ position: 'relative', display: 'flex', flex: narrow ? 1 : 0.8, minWidth: 0 }}><div class="stage-caption glass">Main photo</div>{mainStage}</div>}
            {(!narrow || side === 'new') && <div style={{ position: 'relative', display: 'flex', flex: 1.2, minWidth: 0 }}><div class="stage-caption glass">This photo</div>{newStage}</div>}
          </div>
        )}
        {step === 2 && src && H && (
          <CheckView src={src.url} w={src.img.width} h={src.img.height} H={H} wall={wall} project={project} frames={frames} pictures={pictures} />
        )}
        {step > 0 && (
          <div class="editor-side">
            <div class="panel glass strong grow">
              {step === 1 && (
                <>
                  <h2>Match points</h2>
                  <div class="hint">
                    Drag each numbered pin in <b>this photo</b> onto the same spot as in the main photo. The starting four are the corners of the area you measured. If a corner isn’t visible, remove it and add points you can see in both photos instead: an <b>outlet</b>, the <b>smoke detector</b>, a <b>switch plate</b>, a nail hole, a corner of trim.
                  </div>
                  <div class="hint">Points must be <b>on this wall</b> (not the ceiling or floor). Four is the minimum; five or six spread-out points give a better fit.</div>
                  {narrow && <Segmented value={side} onChange={setSide} options={[{ value: 'main', label: 'Main photo' }, { value: 'new', label: 'This photo' }]} />}
                  <div class="col" style={{ gap: 6 }}>
                    {pairs.map((p, i) => (
                      <div key={i} class={`list-btn ${sel === i ? 'on' : ''}`} onClick={() => setSel(i)}>
                        <span style={{ width: 22, height: 22, borderRadius: 11, background: POINT_COLORS[i % POINT_COLORS.length], display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 700, color: '#111' }}>{i + 1}</span>
                        <div class="t"><div>Point {i + 1}</div><div>{p.photo ? 'placed' : 'not placed'}</div></div>
                        <button class="btn small icon-only ghost danger" disabled={pairs.length <= 4} onClick={(e) => { e.stopPropagation(); setPairs(pairs.filter((_, k) => k !== i)); setSel(null); }} aria-label="Remove point"><Icon name="trash" size={16} /></button>
                      </div>
                    ))}
                  </div>
                  <button class={`btn ${adding ? 'on' : ''}`} onClick={() => { setAdding(!adding); if (narrow) setSide('main'); }}>
                    <Icon name="plus" /> {adding ? 'Tap the spot in the main photo…' : 'Add a reference point'}
                  </button>
                  {H && (
                    <div class="small-text" style={{ color: err < 8 ? 'var(--ok)' : err < 20 ? 'var(--eye)' : 'var(--danger)' }}>
                      Fit: {err < 8 ? 'good' : err < 20 ? 'okay — check the pins' : 'poor — a pin is probably on the wrong spot'} ({err.toFixed(1)} px)
                    </div>
                  )}
                </>
              )}
              {step === 2 && (
                <>
                  <h2>Does it line up?</h2>
                  <div class="hint">Your current layout is drawn into this photo. The blue outline should sit on the area you measured. If it’s off, go back and nudge the pins.</div>
                  <label class="field"><span>Name</span><input class="input" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} /></label>
                  {existing && <button class="btn danger" onClick={remove}><Icon name="trash" /> Remove this view</button>}
                </>
              )}
            </div>
            <div class="row">
              {step > 1 && <button class="btn" onClick={() => go(step - 1)}><Icon name="back" /> Back</button>}
              <div class="grow" />
              {step < 2 ? (
                <button class="btn primary" data-testid="next" disabled={!H} onClick={() => go(step + 1)}>Next <Icon name="next" /></button>
              ) : (
                <button class="btn primary" data-testid="save" onClick={save}><Icon name="check" /> Save view</button>
              )}
            </div>
          </div>
        )}
      </div>
      <div class="editor-head">
        <button class="btn icon-only glass" onClick={close} aria-label="Close"><Icon name="close" /></button>
        <Steps steps={STEPS} current={step} maxReached={maxStep} onGo={(i) => (i === 0 && existing ? null : go(i))} />
      </div>
      {busy && <Busy text={busy} />}
    </div>
  );
}

function CheckView({ src, w, h, H, wall, project, frames, pictures }: {
  src: string; w: number; h: number; H: Mat3; wall: NonNullable<ReturnType<typeof getProject>>['wall'] & object;
  project: NonNullable<ReturnType<typeof getProject>>; frames: Map<string, import('../lib/types').Frame>; pictures: Map<string, import('../lib/types').Picture>;
}) {
  const layout = activeLayout(project);
  const items = layout.items.filter((i) => frames.has(i.frameId));
  const u = unionBox(items.map((i) => footprint(i, frames.get(i.frameId)!)));
  return (
    <PhotoStage
      src={src}
      imgW={w}
      imgH={h}
      html={(api) => {
        const M = multiply3(viewMat(api.view), H);
        const anchor = u ? { x: u.x + u.w / 2, y: u.y + u.h / 2 } : { x: wall.refW / 2, y: wall.refH / 2 };
        const K = Math.max(0.5, localScale(M, anchor));
        return (
          <div class="world" style={{ transform: cssMatrix(multiply3(M, scaleMat(1 / K))), pointerEvents: 'none' }}>
            {items.map((it) => {
              const f = frames.get(it.frameId)!;
              return (
                <div key={it.id} class="item" style={{ left: (it.x - f.widthIn / 2) * K, top: (it.y - f.heightIn / 2) * K, width: f.widthIn * K, height: f.heightIn * K, transform: `rotate(${it.rotation}deg)` }}>
                  <FrameArt frame={f} s={K} fills={it.fills} pictures={pictures} />
                </div>
              );
            })}
          </div>
        );
      }}
    >
      {(api) => (
        <polygon
          points={[[0, 0], [wall.refW, 0], [wall.refW, wall.refH], [0, wall.refH]].map(([x, y]) => { const q = applyH(H, x, y); return `${q.x},${q.y}`; }).join(' ')}
          fill="none" stroke="rgba(143,184,255,0.9)" stroke-width={api.px(1.5)}
        />
      )}
    </PhotoStage>
  );
}
