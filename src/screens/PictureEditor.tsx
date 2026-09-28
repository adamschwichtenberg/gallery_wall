import { useEffect, useState } from 'preact/hooks';
import { CornerPins } from '../components/CornerPins';
import { Icon } from '../components/Icon';
import { Busy, LengthInput, PhotoSource, Steps, Toggle } from '../components/ui';
import { putBlob, uid } from '../lib/db';
import { COLOR_ORDER } from '../lib/detect';
import type { Img } from '../lib/imaging';
import { autoPictureTags, loadSource, loadStoredSource, nextFrame, printSizeLabel, storeCanvas, straightenPicture } from '../lib/pipeline';
import { deletePicture, openModal, savePicture, toast, useStore } from '../lib/store';
import type { Picture, PictureTags, Quad } from '../lib/types';
import { COLOR_SWATCH, FineRotate } from './FrameEditor';

const STEPS = ['Photo', 'Crop', 'Details'];

export function PictureEditor({ id }: { id?: string }) {
  const existing = useStore((s) => s.pictures.find((p) => p.id === id));
  const [step, setStep] = useState(existing ? 1 : 0);
  const [maxStep, setMaxStep] = useState(existing ? 2 : 0);
  const [busy, setBusy] = useState<string | null>(null);
  const [src, setSrc] = useState<{ img: Img; url: string; blob?: Blob; blobId?: string } | null>(null);
  const [quad, setQuad] = useState<Quad | null>(existing?.straighten?.quad ?? null);
  const [fine, setFine] = useState(existing?.straighten?.fineRotation ?? 0);
  const [hasPrint, setHasPrint] = useState(!!existing?.printW);
  const [printW, setPrintW] = useState(existing?.printW ?? 5);
  const [printH, setPrintH] = useState(existing?.printH ?? 7);
  const [preview, setPreview] = useState<{ url: string; aspect: number; canvas: HTMLCanvasElement; img: Img } | null>(null);
  const [name, setName] = useState(existing?.name ?? '');
  const [tags, setTags] = useState<PictureTags | null>(existing?.tags ?? null);
  const [tagText, setTagText] = useState('');

  useEffect(() => {
    if (!existing?.straighten) return;
    loadStoredSource(existing.straighten.sourceBlobId).then((s) => {
      if (s) setSrc({ img: s.img, url: s.canvas.toDataURL('image/jpeg', 0.85), blobId: existing.straighten!.sourceBlobId });
    });
  }, [existing?.id]);

  const close = () => openModal(null);

  const onPhoto = async (file: File) => {
    setBusy('Reading photo…');
    await nextFrame();
    try {
      const s = await loadSource(file);
      setSrc({ img: s.img, url: s.canvas.toDataURL('image/jpeg', 0.85), blob: s.blob });
      const w = s.img.width, h = s.img.height;
      setQuad([{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]);
      if (!name) setName(file.name.replace(/\.[^.]+$/, '').replace(/^IMG_/, 'Photo '));
      go(1);
    } catch (e) {
      toast(String((e as Error).message ?? e));
    } finally {
      setBusy(null);
    }
  };

  const rotateQuad = (dir: 1 | -1) => {
    if (!quad) return;
    setQuad(dir === 1 ? [quad[3], quad[0], quad[1], quad[2]] : [quad[1], quad[2], quad[3], quad[0]]);
    if (hasPrint) { setPrintW(printH); setPrintH(printW); }
  };

  const render = async () => {
    if (!src || !quad) return null;
    setBusy('Cropping…');
    await nextFrame();
    const r = straightenPicture(src.img, quad, fine, hasPrint ? printW : undefined, hasPrint ? printH : undefined);
    const p = { url: r.canvas.toDataURL('image/jpeg', 0.85), aspect: r.aspect, canvas: r.canvas, img: r.img };
    setPreview(p);
    const auto = autoPictureTags(r.img, r.aspect);
    setTags((t) => (t ? { ...t, orientation: auto.orientation } : { ...auto, custom: [] }));
    setBusy(null);
    return p;
  };

  const go = async (n: number) => {
    if (n === 2 && !(await render())) return;
    setStep(n);
    setMaxStep((m) => Math.max(m, n));
  };

  const save = async () => {
    const p = preview ?? (src ? await render() : null);
    setBusy('Saving…');
    await nextFrame();
    try {
      const imageBlobId = p ? await storeCanvas(p.canvas) : existing!.imageBlobId;
      let sourceBlobId = src?.blobId ?? existing?.straighten?.sourceBlobId;
      if (src?.blob) sourceBlobId = await putBlob(src.blob);
      const auto = p ? autoPictureTags(p.img, p.aspect) : null;
      const pic: Picture = {
        id: existing?.id ?? uid(),
        name: name.trim() || 'Picture',
        createdAt: existing?.createdAt ?? Date.now(),
        imageBlobId,
        aspect: p?.aspect ?? existing!.aspect,
        printW: hasPrint ? printW : undefined,
        printH: hasPrint ? printH : undefined,
        tags: tags ?? { ...auto!, custom: [] },
        straighten: sourceBlobId && quad ? { sourceBlobId, quad, fineRotation: fine } : existing?.straighten,
      };
      await savePicture(pic);
      toast(existing ? 'Picture updated' : 'Picture added');
      close();
    } finally {
      setBusy(null);
    }
  };

  const fullImage = () => {
    if (!src) return;
    const w = src.img.width, h = src.img.height;
    setQuad([{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]);
  };

  return (
    <div class="fullscreen-editor">
      <div class="editor-body">
        {step === 0 && (
          <div class="editor-stage">
            <PhotoSource title="Add a picture" onFile={onPhoto} hint={<>Choose a photo from your library, or photograph a print. You can straighten and crop it next — then swap it into any frame.</>} />
          </div>
        )}
        {step === 1 && src && quad && <CornerPins src={src.url} imgW={src.img.width} imgH={src.img.height} quad={quad} onChange={setQuad} />}
        {step === 1 && !src && <div class="editor-stage" style={{ display: 'grid', placeItems: 'center' }}><div class="spinner" /></div>}
        {step === 2 && preview && (
          <div class="editor-stage" style={{ display: 'grid', placeItems: 'center', background: 'radial-gradient(circle at 50% 40%, #2a2a33, #0b0b0e)' }}>
            <img src={preview.url} style={{ maxWidth: '80%', maxHeight: '75%', boxShadow: '0 20px 40px rgba(0,0,0,0.5)' }} />
          </div>
        )}
        {step > 0 && (
          <div class="editor-side">
            <div class="panel glass strong grow">
              {step === 1 && (
                <>
                  <h2>Crop & straighten</h2>
                  <div class="hint">Drag the pins to the corners of the picture. If you photographed a print at an angle, this also straightens it.</div>
                  <button class="btn small" onClick={fullImage}>Use the whole photo</button>
                  <div class="section-title">Rotate</div>
                  <div class="row">
                    <button class="btn" onClick={() => rotateQuad(-1)}><Icon name="rotL" /> 90°</button>
                    <button class="btn" onClick={() => rotateQuad(1)}><Icon name="rotR" /> 90°</button>
                  </div>
                  <FineRotate value={fine} onChange={setFine} />
                  <Toggle label="I know the print size" on={hasPrint} onChange={setHasPrint} />
                  {hasPrint && (
                    <div class="row">
                      <div class="grow"><LengthInput label="Width" value={printW} onChange={setPrintW} /></div>
                      <div class="grow"><LengthInput label="Height" value={printH} onChange={setPrintH} /></div>
                    </div>
                  )}
                </>
              )}
              {step === 2 && tags && preview && (
                <>
                  <h2>Details</h2>
                  <div class="faint small-text">{tags.orientation}{printSizeLabel(preview.aspect) ? ` · ${printSizeLabel(preview.aspect)}` : ''}</div>
                  <label class="field"><span>Name</span><input class="input" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} /></label>
                  <div class="section-title">Main color</div>
                  <div class="chips">
                    {COLOR_ORDER.filter((c) => c !== 'gold' && c !== 'silver' && c !== 'wood').map((c) => (
                      <button key={c} class={`chip ${tags.color === c ? 'on' : ''}`} onClick={() => setTags({ ...tags, color: c })}>
                        <span class="dot" style={{ background: tags.color === c ? tags.colorHex : COLOR_SWATCH[c] }} />{c}
                      </button>
                    ))}
                  </div>
                  <div class="section-title">Your tags</div>
                  <div class="chips">
                    {tags.custom.map((t) => <button key={t} class="chip on" onClick={() => setTags({ ...tags, custom: tags.custom.filter((x) => x !== t) })}>{t} <Icon name="close" size={12} /></button>)}
                  </div>
                  <form class="row" onSubmit={(e) => { e.preventDefault(); const t = tagText.trim().toLowerCase(); if (t && !tags.custom.includes(t)) setTags({ ...tags, custom: [...tags.custom, t] }); setTagText(''); }}>
                    <input class="input" placeholder="e.g. family, travel, botanical" value={tagText} onInput={(e) => setTagText((e.target as HTMLInputElement).value)} />
                    <button class="btn" type="submit">Add</button>
                  </form>
                  {existing && (
                    <button class="btn danger" onClick={async () => { if (confirm('Delete this picture?')) { await deletePicture(existing.id); close(); } }}><Icon name="trash" /> Delete picture</button>
                  )}
                </>
              )}
            </div>
            <div class="row">
              {step > 1 && <button class="btn" onClick={() => go(step - 1)}><Icon name="back" /> Back</button>}
              <div class="grow" />
              {step < 2 ? (
                <button class="btn primary" data-testid="next" onClick={() => go(step + 1)}>Next <Icon name="next" /></button>
              ) : (
                <button class="btn primary" data-testid="save" onClick={save}><Icon name="check" /> Save picture</button>
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
