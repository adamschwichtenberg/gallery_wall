import { useEffect, useState } from 'preact/hooks';
import { CornerPins } from '../components/CornerPins';
import { Icon } from '../components/Icon';
import { PhotoStage } from '../components/PhotoStage';
import { Busy, LengthInput, PhotoSource, Segmented, Steps, Toggle } from '../components/ui';
import { applyH, homography } from '../lib/geometry';
import { deleteBlob, putBlob } from '../lib/db';
import { imgToCanvas, pxPerUnitFor, visibleExtent, warp, type Img } from '../lib/imaging';
import { loadSource, loadStoredSource, nextFrame, storeCanvas } from '../lib/pipeline';
import { getProject, openModal, saveProject, toast, useStore } from '../lib/store';
import type { Quad, Wall } from '../lib/types';
import { fmtLen } from '../lib/units';

const STEPS = ['Photo', 'Measure', 'Review'];

export function WallEditor({ projectId }: { projectId: string }) {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  const units = useStore((s) => s.prefs.units);
  const wall = project?.wall;
  const [step, setStep] = useState(wall ? 1 : 0);
  const [maxStep, setMaxStep] = useState(wall ? 2 : 0);
  const [busy, setBusy] = useState<string | null>(null);
  const [src, setSrc] = useState<{ img: Img; url: string; blob?: Blob; blobId?: string } | null>(null);
  const [quad, setQuad] = useState<Quad | null>(wall?.quad ?? null);
  const [refW, setRefW] = useState(wall?.refW ?? 0);
  const [refH, setRefH] = useState(wall?.refH ?? 0);
  const [bottom, setBottom] = useState(wall?.bottomAboveFloor ?? 0);
  const [ceiling, setCeiling] = useState(wall?.ceilingHeight ?? 0);
  const [review, setReview] = useState<'photo' | 'straight'>(project?.settings.viewMode === 'straight' ? 'straight' : 'photo');
  const [extend, setExtend] = useState(true);
  const [result, setResult] = useState<{ canvas: HTMLCanvasElement; url: string; x0: number; y0: number; x1: number; y1: number } | null>(null);

  useEffect(() => {
    if (!wall) return;
    loadStoredSource(wall.sourceBlobId).then((s) => s && setSrc({ img: s.img, url: s.canvas.toDataURL('image/jpeg', 0.85), blobId: wall.sourceBlobId }));
  }, [wall?.sourceBlobId]);

  const close = () => openModal(null);

  const onPhoto = async (file: File) => {
    setBusy('Reading photo…');
    await nextFrame();
    try {
      const s = await loadSource(file);
      setSrc({ img: s.img, url: s.canvas.toDataURL('image/jpeg', 0.85), blob: s.blob });
      const w = s.img.width, h = s.img.height;
      setQuad([{ x: w * 0.15, y: h * 0.15 }, { x: w * 0.85, y: h * 0.15 }, { x: w * 0.85, y: h * 0.85 }, { x: w * 0.15, y: h * 0.85 }]);
      go(1);
    } catch (e) {
      toast(String((e as Error).message ?? e));
    } finally {
      setBusy(null);
    }
  };

  const compute = async () => {
    if (!src || !quad) return null;
    if (!(refW > 0 && refH > 0)) {
      toast('Enter the width and height of the area you pinned');
      return null;
    }
    setBusy('Straightening the wall…');
    await nextFrame();
    try {
      const floor = refH + bottom;
      const ext = extend ? visibleExtent(src.img.width, src.img.height, quad, refW, refH, 1) : { x0: 0, y0: 0, x1: refW, y1: refH };
      // A strip of floor is useful context; more than that just wastes pixels.
      ext.y1 = Math.min(ext.y1, Math.max(refH, floor + Math.max(8, refH * 0.1)));
      ext.y0 = Math.max(ext.y0, -Math.max(12, refH * 0.25));
      // Keep the floor in view when it's close below the pinned area.
      const ppi = pxPerUnitFor(ext.x1 - ext.x0, ext.y1 - ext.y0, 2600);
      const img = warp(src.img, { quad, w: refW, h: refH, ...ext, pxPerUnit: ppi });
      const canvas = imgToCanvas(img);
      const r = { canvas, url: canvas.toDataURL('image/jpeg', 0.85), ...ext };
      setResult(r);
      return r;
    } finally {
      setBusy(null);
    }
  };

  const go = async (n: number) => {
    if (n === 2 && !(await compute())) return;
    setStep(n);
    setMaxStep((m) => Math.max(m, n));
  };

  const save = async () => {
    const r = result ?? (await compute());
    const p = getProject(projectId);
    if (!r || !p || !quad || !src) return;
    setBusy('Saving…');
    await nextFrame();
    try {
      const imageBlobId = await storeCanvas(r.canvas, 'image/jpeg', 0.9);
      let sourceBlobId = src.blobId ?? wall?.sourceBlobId ?? '';
      if (src.blob) sourceBlobId = await putBlob(src.blob);
      if (wall) {
        await deleteBlob(wall.imageBlobId);
        await deleteBlob(wall.paintedBlobId);
        if (wall.sourceBlobId !== sourceBlobId) await deleteBlob(wall.sourceBlobId);
      }
      const next: Wall = {
        sourceBlobId, quad, refW, refH, bottomAboveFloor: bottom, imageBlobId,
        ceilingHeight: ceiling > 0 ? ceiling : undefined,
        x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1,
        paint: wall?.paint,
      };
      // Old paint results no longer line up with new pins; the paint panel re-renders them.
      if (wall && JSON.stringify(wall.quad) !== JSON.stringify(quad)) { next.paintedBlobId = undefined; next.paintedSrcBlobId = undefined; }
      await saveProject({ ...p, wall: next, settings: { ...p.settings, viewMode: review } });
      toast('Wall saved');
      close();
    } finally {
      setBusy(null);
    }
  };

  const floorY = refH + bottom;

  return (
    <div class="fullscreen-editor">
      <div class="editor-body">
        {step === 0 && (
          <div class="editor-stage">
            <PhotoSource
              title="Photograph your wall"
              onFile={onPhoto}
              hint={<>Stand back and include the whole area you want to hang on. Straight-on is best, but an angle is fine — you’ll straighten it by pinning a rectangle you’ve measured.</>}
            />
          </div>
        )}
        {step === 1 && src && quad && (
          <CornerPins
            src={src.url}
            imgW={src.img.width}
            imgH={src.img.height}
            quad={quad}
            onChange={setQuad}
            edgeLabels={refW > 0 && refH > 0 ? { top: `${fmtLen(refW, units)}`, left: `${fmtLen(refH, units)}` } : undefined}
          />
        )}
        {step === 1 && !src && <div class="editor-stage" style={{ display: 'grid', placeItems: 'center' }}><div class="spinner" /></div>}
        {step === 2 && result && (
          review === 'straight' ? (
            <ReviewImage result={result} refW={refW} refH={refH} floorY={floorY} eye={project?.settings.eyeLevel ?? 57} />
          ) : src && quad ? (
            <PhotoReview src={src.url} w={src.img.width} h={src.img.height} quad={quad} refW={refW} refH={refH} floorY={floorY} eye={project?.settings.eyeLevel ?? 57} x0={result.x0} x1={result.x1} />
          ) : null
        )}
        {step > 0 && (
          <div class="editor-side">
            <div class="panel glass strong grow">
              {step === 1 && (
                <>
                  <h2>Pin a rectangle you know</h2>
                  <div class="hint">
                    Drag the pins onto the four corners of something rectangular <b>on the wall</b> whose size you’ve measured, e.g. the wall from corner to corner and ceiling to baseboard.
                  </div>
                  <div class="hint">
                    <b>Tip:</b> if the wall has no clear corners, put up two strips of painter’s tape a measured distance apart and pin those.
                  </div>
                  <div class="row">
                    <div class="grow"><LengthInput label="Width" value={refW} onChange={setRefW} big /></div>
                    <div class="grow"><LengthInput label="Height" value={refH} onChange={setRefH} big /></div>
                  </div>
                  <LengthInput label="Bottom edge height above floor" value={bottom} onChange={setBottom} placeholder="0 if it touches the floor" />
                  <div class="faint small-text">Used for the eye-level line and height readouts. Enter 0 if the bottom pins sit on the floor.</div>
                  <LengthInput label="Ceiling height (optional)" value={ceiling} onChange={setCeiling} placeholder="floor to ceiling, e.g. 96" />
                  <div class="faint small-text">Helps the wall-color preview stop at the ceiling line.</div>
                  <Toggle label="Include the rest of the photo" on={extend} onChange={setExtend} />
                </>
              )}
              {step === 2 && (
                <>
                  <h2>How do you want to work?</h2>
                  <Segmented value={review} onChange={setReview} options={[{ value: 'photo', label: 'As photographed' }, { value: 'straight', label: 'Straightened' }]} />
                  <div class="hint">
                    {review === 'photo'
                      ? <><b>As photographed</b> keeps your photo exactly as taken. Frames follow the wall’s perspective and get smaller as you slide them away from the camera.</>
                      : <><b>Straightened</b> squares the wall up as if you were standing directly in front of it, which is handy for precise spacing.</>}
                  </div>
                  <div class="hint">You can switch any time with the <b>Photo / Straight-on</b> toggle at the top of the wall screen. The yellow line is eye level ({fmtLen(project?.settings.eyeLevel ?? 57, units)} from the floor); if it looks off, go back and nudge the pins.</div>
                </>
              )}
            </div>
            <div class="row">
              {step > 1 && <button class="btn" onClick={() => go(step - 1)}><Icon name="back" /> Back</button>}
              <div class="grow" />
              {step < 2 ? (
                <button class="btn primary" data-testid="next" onClick={() => go(step + 1)}>Next <Icon name="next" /></button>
              ) : (
                <button class="btn primary" data-testid="save" onClick={save}><Icon name="check" /> Use this wall</button>
              )}
            </div>
          </div>
        )}
      </div>
      <div class="editor-head">
        <button class="btn icon-only glass" onClick={close} aria-label="Close"><Icon name="close" /></button>
        <Steps steps={STEPS} current={step} maxReached={maxStep} onGo={go} />
      </div>
      {busy && <Busy text={busy} />}
    </div>
  );
}

function ReviewImage({ result, refW, refH, floorY, eye }: { result: { url: string; canvas: HTMLCanvasElement; x0: number; y0: number; x1: number; y1: number }; refW: number; refH: number; floorY: number; eye: number }) {
  const ppi = result.canvas.width / (result.x1 - result.x0);
  const X = (x: number) => (x - result.x0) * ppi, Y = (y: number) => (y - result.y0) * ppi;
  return (
    <PhotoStage src={result.url} imgW={result.canvas.width} imgH={result.canvas.height}>
      {(api) => (
        <>
          <rect x={X(0)} y={Y(0)} width={refW * ppi} height={refH * ppi} fill="none" stroke="rgba(143,184,255,0.9)" stroke-width={api.px(1.5)} />
          <line x1={0} x2={result.canvas.width} y1={Y(floorY - eye)} y2={Y(floorY - eye)} class="eye-line" style={{ strokeWidth: api.px(2) }} stroke-dasharray={`${api.px(10)} ${api.px(6)}`} />
          <line x1={0} x2={result.canvas.width} y1={Y(floorY)} y2={Y(floorY)} stroke="rgba(255,255,255,0.5)" stroke-width={api.px(1)} />
        </>
      )}
    </PhotoStage>
  );
}

function PhotoReview({ src, w, h, quad, refW, refH, floorY, eye, x0, x1 }: { src: string; w: number; h: number; quad: Quad; refW: number; refH: number; floorY: number; eye: number; x0: number; x1: number }) {
  const H = homography([{ x: 0, y: 0 }, { x: refW, y: 0 }, { x: refW, y: refH }, { x: 0, y: refH }], quad);
  const a = applyH(H, x0, floorY - eye), b = applyH(H, x1, floorY - eye);
  return (
    <PhotoStage src={src} imgW={w} imgH={h}>
      {(api) => (
        <>
          <polygon points={quad.map((p) => `${p.x},${p.y}`).join(' ')} fill="rgba(143,184,255,0.12)" stroke="rgba(143,184,255,0.9)" stroke-width={api.px(1.5)} />
          <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} class="eye-line" style={{ strokeWidth: api.px(2) }} stroke-dasharray={`${api.px(10)} ${api.px(6)}`} />
        </>
      )}
    </PhotoStage>
  );
}
