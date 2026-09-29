import { useEffect, useMemo, useState } from 'preact/hooks';
import { CornerPins } from '../components/CornerPins';
import { Icon } from '../components/Icon';
import { gridOpenings, OpeningsEditor } from '../components/OpeningsEditor';
import { OutlineEditor, presetOutline, type OutlineTool } from '../components/OutlineEditor';
import { Busy, LengthInput, Len, PhotoSource, Segmented, Steps, Toggle, useBlobUrl } from '../components/ui';
import { putBlob, uid } from '../lib/db';
import { COLOR_ORDER, contourToOutline, detectFrame, detectOpenings } from '../lib/detect';
import type { Img } from '../lib/imaging';
import { autoFrameTags, loadSource, loadStoredSource, nextFrame, storeCanvas, straightenFrame, type Straightened } from '../lib/pipeline';
import { deleteFrame, getState, openModal, saveFrame, toast, useStore } from '../lib/store';
import type { Frame, FrameShape, FrameTags, Opening, Pt, Quad, SizeGroup } from '../lib/types';
import { fmtSize, SIZE_LABEL } from '../lib/units';

const STEPS = ['Photo', 'Corners & size', 'Outline', 'Openings', 'Details'];
const SHAPES: FrameShape[] = ['rectangular', 'circular/oval', 'irregular'];

export function FrameEditor({ id }: { id?: string }) {
  const existing = useStore((s) => s.frames.find((f) => f.id === id));
  const units = useStore((s) => s.prefs.units);
  const [step, setStep] = useState(existing ? 1 : 0);
  const [maxStep, setMaxStep] = useState(existing ? 4 : 0);
  const [busy, setBusy] = useState<string | null>(null);

  // Source photo
  const [src, setSrc] = useState<{ img: Img; url: string; blobId?: string; blob?: Blob } | null>(null);
  const [quad, setQuad] = useState<Quad | null>(existing?.straighten?.quad ?? null);
  const [contour, setContour] = useState<Pt[] | null>(null);
  const [wIn, setW] = useState(existing?.widthIn ?? 0);
  const [hIn, setH] = useState(existing?.heightIn ?? 0);
  const [fine, setFine] = useState(existing?.straighten?.fineRotation ?? 0);

  // Derived results
  const [rect, setRect] = useState<Straightened | null>(null);
  const [rectKey, setRectKey] = useState('');
  const [outline, setOutline] = useState<Pt[]>(existing?.outline ?? []);
  const [outlineAuto, setOutlineAuto] = useState(!existing);
  const [tool, setTool] = useState<OutlineTool>('edit');
  const [openings, setOpenings] = useState<Opening[]>(existing?.openings ?? []);
  const [openingsTouched, setOpeningsTouched] = useState(!!existing);
  const [matted, setMatted] = useState(existing?.tags.matted ?? false);
  const [selOpening, setSelOpening] = useState<string | null>(null);
  const [grid, setGrid] = useState({ rows: 3, cols: 3, w: 2.5, h: 3.5, inset: 1.5 });

  // Details
  const [name, setName] = useState(existing?.name ?? '');
  const [qty, setQty] = useState(existing?.qty ?? 1);
  const [depth, setDepth] = useState(existing?.depthIn ?? 1);
  const [tags, setTags] = useState<FrameTags | null>(existing?.tags ?? null);
  const [tagText, setTagText] = useState('');
  const [notes, setNotes] = useState(existing?.notes ?? '');

  const existingImgUrl = useBlobUrl(existing?.imageBlobId);

  // Load the stored source photo when editing.
  useEffect(() => {
    if (!existing?.straighten) return;
    (async () => {
      const s = await loadStoredSource(existing.straighten!.sourceBlobId);
      if (s) setSrc({ img: s.img, url: s.canvas.toDataURL('image/jpeg', 0.85), blobId: existing.straighten!.sourceBlobId });
    })();
  }, [existing?.id]);

  const close = () => openModal(null);

  const onPhoto = async (file: File) => {
    setBusy('Reading photo…');
    await nextFrame();
    try {
      const s = await loadSource(file);
      setSrc({ img: s.img, url: s.canvas.toDataURL('image/jpeg', 0.85), blob: s.blob });
      setBusy('Finding the frame…');
      await nextFrame();
      const det = detectFrame(s.img);
      if (det) {
        setQuad(det.quad);
        setContour(det.contour);
      } else {
        const w = s.img.width, h = s.img.height;
        setQuad([{ x: w * 0.2, y: h * 0.2 }, { x: w * 0.8, y: h * 0.2 }, { x: w * 0.8, y: h * 0.8 }, { x: w * 0.2, y: h * 0.8 }]);
        toast('Couldn’t find the frame automatically — drag the pins to its corners');
      }
      go(1);
    } catch (e) {
      toast(String((e as Error).message ?? e));
    } finally {
      setBusy(null);
    }
  };

  const redetect = async () => {
    if (!src) return;
    setBusy('Finding the frame…');
    await nextFrame();
    const det = detectFrame(src.img);
    setBusy(null);
    if (det) {
      setQuad(det.quad);
      setContour(det.contour);
      setOutlineAuto(true);
    } else toast('No frame found — try a plainer background');
  };

  const rotateQuad = (dir: 1 | -1) => {
    if (!quad) return;
    // Rotating the result clockwise makes the old bottom-left the new top-left.
    const q = dir === 1 ? ([quad[3], quad[0], quad[1], quad[2]] as Quad) : ([quad[1], quad[2], quad[3], quad[0]] as Quad);
    setQuad(q);
    setW(hIn);
    setH(wIn);
    // Carry any hand-edited outline and openings round with the frame.
    const rot = (p: Pt): Pt => (dir === 1 ? { x: hIn - p.y, y: p.x } : { x: p.y, y: wIn - p.x });
    setOutline((o) => o.map(rot));
    setOpenings((ops) =>
      ops.map((o) => {
        const a = rot({ x: o.x, y: o.y }), b = rot({ x: o.x + o.w, y: o.y + o.h });
        return { ...o, x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: o.h, h: o.w };
      }),
    );
  };

  const key = quad ? JSON.stringify([quad, wIn, hIn, fine]) : '';

  /** Make sure the straightened image is current (recomputed when pins/size change). */
  const ensureRect = async (): Promise<Straightened | null> => {
    if (!src || !quad || !(wIn > 0 && hIn > 0)) return null;
    if (rect && rectKey === key) return rect;
    setBusy('Straightening…');
    await nextFrame();
    const r = straightenFrame(src.img, quad, wIn, hIn, fine);
    setRect(r);
    setRectKey(key);
    if (outlineAuto || !outline.length) {
      setOutline(contour ? contourToOutline(contour, quad, wIn, hIn, fine) : presetOutline('rect', wIn, hIn));
    }
    setBusy(null);
    return r;
  };

  const ensureOpenings = async (r: Straightened) => {
    if (openingsTouched && openings.length) return;
    setBusy('Looking for openings…');
    await nextFrame();
    const d = detectOpenings(r.img, r.ppi, r.padX, r.padY, wIn, hIn);
    setOpenings(d.openings);
    setMatted(d.matted);
    setOpeningsTouched(true);
    setBusy(null);
  };

  const ensureTags = (r: Straightened) => {
    const auto = autoFrameTags(r, outline, openings, matted, wIn, hIn);
    setTags((t) => (t ? { ...t, size: auto.size, matted: t.matted || openings.length > 1 } : { ...auto, custom: [] }));
    if (!name) setName(`${auto.color[0].toUpperCase()}${auto.color.slice(1)} ${auto.shape === 'rectangular' ? 'frame' : auto.shape.split('/')[0] + ' frame'}`);
  };

  const go = async (n: number) => {
    if (n >= 2) {
      if (!(wIn > 0 && hIn > 0)) {
        toast('Enter the frame’s outside width and height first');
        setStep(1);
        return;
      }
      const r = await ensureRect();
      if (!r) return;
      if (n >= 3) await ensureOpenings(r);
      if (n >= 4) ensureTags(r);
    }
    setStep(n);
    setMaxStep((m) => Math.max(m, n));
  };

  const save = async () => {
    const r = await ensureRect();
    if (!r && !existing) return;
    setBusy('Saving…');
    await nextFrame();
    try {
      let imageBlobId = existing?.imageBlobId ?? '';
      let padX = existing?.padX ?? 0, padY = existing?.padY ?? 0;
      if (r) {
        imageBlobId = await storeCanvas(r.canvas, 'image/jpeg', 0.9);
        padX = r.padX;
        padY = r.padY;
      }
      let sourceBlobId = src?.blobId ?? existing?.straighten?.sourceBlobId;
      if (src?.blob) sourceBlobId = await putBlob(src.blob);
      const auto = r ? autoFrameTags(r, outline, openings, matted, wIn, hIn) : null;
      const f: Frame = {
        id: existing?.id ?? uid(),
        name: name.trim() || 'Frame',
        createdAt: existing?.createdAt ?? Date.now(),
        qty: Math.max(1, qty),
        widthIn: wIn,
        heightIn: hIn,
        depthIn: depth > 0 ? depth : 1,
        imageBlobId,
        padX,
        padY,
        outline,
        openings,
        tags: tags ?? { ...auto!, custom: [] },
        straighten: sourceBlobId && quad ? { sourceBlobId, quad, fineRotation: fine } : existing?.straighten,
        notes: notes.trim() || undefined,
      };
      await saveFrame(f);
      toast(existing ? 'Frame updated' : 'Frame added to inventory');
      close();
    } finally {
      setBusy(null);
    }
  };

  const edgeLabels = useMemo(
    () => (wIn > 0 && hIn > 0 ? { top: `▲ Top · ${fmtLen2(wIn, units)} wide`, left: `${fmtLen2(hIn, units)} tall` } : undefined),
    [wIn, hIn, units],
  );

  return (
    <div class="fullscreen-editor">
      <div class="editor-body">
        {step === 0 && (
          <div class="editor-stage">
            <PhotoSource
              title="Photograph a frame"
              onFile={onPhoto}
              hint={
                <>
                  Lay the frame on a <b>plain floor or table</b> and shoot from directly above. A contrasting background makes the automatic cut-out work best.
                  You’ll enter its measurements next.
                </>
              }
            />
          </div>
        )}
        {step === 1 && src && quad && (
          <CornerPins
            src={src.url}
            imgW={src.img.width}
            imgH={src.img.height}
            quad={quad}
            onChange={(q) => { setQuad(q); setOutlineAuto(true); }}
            edgeLabels={edgeLabels}
            under={(api) =>
              contour ? (
                <polygon points={contour.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="rgba(110,231,168,0.8)" stroke-width={api.px(1.5)} stroke-dasharray={`${api.px(4)} ${api.px(3)}`} />
              ) : null
            }
          />
        )}
        {step === 1 && !src && existing && (
          <div class="editor-stage" style={{ display: 'grid', placeItems: 'center' }}>
            {existingImgUrl ? <img src={existingImgUrl} style={{ maxWidth: '70%', maxHeight: '70%' }} /> : <div class="spinner" />}
          </div>
        )}
        {step === 2 && rect && (
          <OutlineEditor src={rect.url} imgW={rect.img.width} imgH={rect.img.height} ppi={rect.ppi} padX={rect.padX} padY={rect.padY} outline={outline} onChange={(o) => { setOutline(o); setOutlineAuto(false); }} tool={tool} wIn={wIn} hIn={hIn} />
        )}
        {step === 3 && rect && (
          <OpeningsEditor
            src={rect.url} imgW={rect.img.width} imgH={rect.img.height} ppi={rect.ppi} padX={rect.padX} padY={rect.padY}
            outline={outline} openings={openings} selected={selOpening} onSelect={setSelOpening}
            onChange={(o) => { setOpenings(o); setOpeningsTouched(true); }}
            label={(o) => fmtSize(o.w, o.h, units)}
          />
        )}
        {step === 4 && rect && (
          <div class="editor-stage" style={{ display: 'grid', placeItems: 'center', background: 'radial-gradient(circle at 50% 40%, #2a2a33, #0b0b0e)' }}>
            <FramePreview rect={rect} outline={outline} />
          </div>
        )}

        {step > 0 && (
          <div class="editor-side">
            <div class="panel glass strong grow">
              {step === 1 && (
                <>
                  <h2>Corners & size</h2>
                  <div class="hint">
                    Drag the four pins onto the frame’s <b>outer corners</b>. Pins can sit a little outside the photo edge if needed. The dashed green line is the detected outline.
                  </div>
                  <div class="row">
                    <div class="grow"><LengthInput label="Outside width" value={wIn} onChange={setW} big /></div>
                    <div class="grow"><LengthInput label="Outside height" value={hIn} onChange={setH} big /></div>
                  </div>
                  <div class="section-title">Rotate</div>
                  <div class="row">
                    <button class="btn" onClick={() => rotateQuad(-1)}><Icon name="rotL" /> 90°</button>
                    <button class="btn" onClick={() => rotateQuad(1)}><Icon name="rotR" /> 90°</button>
                  </div>
                  <FineRotate value={fine} onChange={setFine} />
                  {src && (
                    <button class="btn" onClick={redetect}><Icon name="wand" /> Auto-detect again</button>
                  )}
                  {!src && existing && <div class="hint">This frame has no original photo stored, so its corners can’t be re-adjusted. You can still edit size, outline, openings and details.</div>}
                </>
              )}
              {step === 2 && (
                <>
                  <h2>Outline</h2>
                  <div class="hint">
                    This is the cut-out used on your wall. <b>Drag points</b> to adjust, <b>tap an edge</b> to add a point, <b>double-tap</b> a point to remove it — or draw a new outline with the lasso.
                  </div>
                  <Segmented value={tool} onChange={setTool} options={[{ value: 'edit', label: <><Icon name="pen" size={16} /> Points</> }, { value: 'lasso', label: <><Icon name="lasso" size={16} /> Lasso</> }]} />
                  <div class="section-title">Presets</div>
                  <div class="row wrap">
                    <button class="btn small" onClick={() => { setOutline(presetOutline('rect', wIn, hIn)); setOutlineAuto(false); }}><Icon name="rect" size={16} /> Rectangle</button>
                    <button class="btn small" onClick={() => { setOutline(presetOutline('oval', wIn, hIn)); setOutlineAuto(false); }}><Icon name="oval" size={16} /> Oval</button>
                    {contour && quad && (
                      <button class="btn small" onClick={() => { setOutline(contourToOutline(contour, quad, wIn, hIn, fine)); setOutlineAuto(true); }}><Icon name="wand" size={16} /> Auto</button>
                    )}
                  </div>
                  <div class="faint small-text">{outline.length} points</div>
                </>
              )}
              {step === 3 && (
                <>
                  <h2>Openings</h2>
                  <div class="hint">
                    Openings are the windows where pictures show. Mats with several windows get one opening each. Drag to move, pull the corners to resize.
                  </div>
                  <div class="row wrap">
                    <button class="btn small" onClick={async () => { setOpeningsTouched(false); rect && (await ensureOpeningsForce(rect)); }}><Icon name="wand" size={16} /> Auto-detect</button>
                    <button class="btn small" onClick={() => addOpening('rect')}><Icon name="rect" size={16} /> Add</button>
                    <button class="btn small" onClick={() => addOpening('oval')}><Icon name="oval" size={16} /> Add oval</button>
                  </div>
                  <Toggle label="Matted" on={matted} onChange={setMatted} />
                  {selOpening && (() => {
                    const o = openings.find((x) => x.id === selOpening);
                    if (!o) return null;
                    const upd = (patch: Partial<Opening>) => { setOpenings(openings.map((x) => (x.id === o.id ? { ...x, ...patch } : x))); setOpeningsTouched(true); };
                    return (
                      <div class="col glass" style={{ padding: 12, borderRadius: 14 }}>
                        <div class="row" style={{ justifyContent: 'space-between' }}>
                          <b>Selected opening</b>
                          <button class="btn small danger" onClick={() => { setOpenings(openings.filter((x) => x.id !== o.id)); setSelOpening(null); }}><Icon name="trash" size={16} /></button>
                        </div>
                        <div class="row">
                          <div class="grow"><LengthInput label="Width" value={o.w} onChange={(w) => upd({ w })} /></div>
                          <div class="grow"><LengthInput label="Height" value={o.h} onChange={(h) => upd({ h })} /></div>
                        </div>
                        <div class="row">
                          <button class="btn small" onClick={() => upd({ x: (wIn - o.w) / 2 })}>Center ↔</button>
                          <button class="btn small" onClick={() => upd({ y: (hIn - o.h) / 2 })}>Center ↕</button>
                          <button class="btn small" onClick={() => upd({ shape: o.shape === 'rect' ? 'oval' : 'rect' })}>{o.shape === 'rect' ? 'Make oval' : 'Make rectangle'}</button>
                        </div>
                        {openings.length > 1 && (
                          <button class="btn small" onClick={() => { setOpenings(openings.map((x) => ({ ...x, w: o.w, h: o.h, shape: o.shape }))); }}>Apply this size to all openings</button>
                        )}
                      </div>
                    );
                  })()}
                  <details>
                    <summary class="section-title" style={{ cursor: 'pointer' }}>Grid helper (multi-opening mats)</summary>
                    <div class="col" style={{ marginTop: 10 }}>
                      <div class="row">
                        <label class="field grow"><span>Rows</span><input class="input" type="number" min={1} max={8} value={grid.rows} onInput={(e) => setGrid({ ...grid, rows: +(e.target as HTMLInputElement).value || 1 })} /></label>
                        <label class="field grow"><span>Columns</span><input class="input" type="number" min={1} max={8} value={grid.cols} onInput={(e) => setGrid({ ...grid, cols: +(e.target as HTMLInputElement).value || 1 })} /></label>
                      </div>
                      <div class="row">
                        <div class="grow"><LengthInput label="Opening W" value={grid.w} onChange={(w) => setGrid({ ...grid, w })} /></div>
                        <div class="grow"><LengthInput label="Opening H" value={grid.h} onChange={(h) => setGrid({ ...grid, h })} /></div>
                      </div>
                      <LengthInput label="Frame molding width" value={grid.inset} onChange={(inset) => setGrid({ ...grid, inset })} />
                      <button class="btn" onClick={() => { setOpenings(gridOpenings(wIn, hIn, grid.rows, grid.cols, grid.w, grid.h, grid.inset)); setOpeningsTouched(true); setMatted(true); }}>Create {grid.rows * grid.cols} openings</button>
                    </div>
                  </details>
                  <div class="faint small-text">{openings.length} opening{openings.length === 1 ? '' : 's'}</div>
                </>
              )}
              {step === 4 && tags && (
                <>
                  <div class="row" style={{ alignItems: 'baseline', justifyContent: 'space-between' }}>
                    <h1 style={{ fontSize: 34 }}>{fmtSize(wIn, hIn, units)}</h1>
                    <span class="faint">{openings.length} opening{openings.length === 1 ? '' : 's'}</span>
                  </div>
                  <label class="field"><span>Name</span><input class="input" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} /></label>
                  <label class="field">
                    <span>How many do you own?</span>
                    <div class="row">
                      <button class="btn icon-only" onClick={() => setQty(Math.max(1, qty - 1))}><Icon name="minus" /></button>
                      <b style={{ fontSize: 20, minWidth: 30, textAlign: 'center' }}>{qty}</b>
                      <button class="btn icon-only" onClick={() => setQty(qty + 1)}><Icon name="plus" /></button>
                    </div>
                  </label>
                  <LengthInput label="Depth off the wall (for 3D and AR)" value={depth} onChange={setDepth} />
                  <div class="section-title">Shape</div>
                  <div class="chips">
                    {SHAPES.map((s) => <button key={s} class={`chip ${tags.shape === s ? 'on' : ''}`} onClick={() => setTags({ ...tags, shape: s })}>{s}</button>)}
                  </div>
                  <div class="section-title">Color</div>
                  <div class="chips">
                    {COLOR_ORDER.map((c) => (
                      <button key={c} class={`chip ${tags.color === c ? 'on' : ''}`} onClick={() => setTags({ ...tags, color: c })}>
                        <span class="dot" style={{ background: tags.color === c ? tags.colorHex : COLOR_SWATCH[c] }} />{c}
                      </button>
                    ))}
                  </div>
                  <div class="section-title">Size group</div>
                  <div class="chips">
                    {(['S', 'M', 'L', 'XL'] as SizeGroup[]).map((s) => <button key={s} class={`chip ${tags.size === s ? 'on' : ''}`} onClick={() => setTags({ ...tags, size: s })}>{SIZE_LABEL[s]}</button>)}
                  </div>
                  <Toggle label="Matted" on={tags.matted} onChange={(m) => setTags({ ...tags, matted: m })} />
                  <div class="section-title">Your tags</div>
                  <div class="chips">
                    {tags.custom.map((t) => (
                      <button key={t} class="chip on" onClick={() => setTags({ ...tags, custom: tags.custom.filter((x) => x !== t) })}>{t} <Icon name="close" size={12} /></button>
                    ))}
                  </div>
                  <form class="row" onSubmit={(e) => { e.preventDefault(); addTag(); }}>
                    <input class="input" placeholder="e.g. hallway, vintage, gift" value={tagText} onInput={(e) => setTagText((e.target as HTMLInputElement).value)} list="known-tags" />
                    <button class="btn" type="submit">Add</button>
                  </form>
                  <datalist id="known-tags">{knownTags().map((t) => <option key={t} value={t} />)}</datalist>
                  <label class="field"><span>Notes</span><textarea class="input" style={{ minHeight: 70, paddingTop: 10 }} value={notes} onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)} /></label>
                  {existing && (
                    <button class="btn danger" onClick={async () => { if (confirm('Delete this frame? It will also be removed from your layouts.')) { await deleteFrame(existing.id); close(); } }}>
                      <Icon name="trash" /> Delete frame
                    </button>
                  )}
                </>
              )}
            </div>
            <div class="row">
              {step > 1 && <button class="btn" onClick={() => go(step - 1)}><Icon name="back" /> Back</button>}
              <div class="grow" />
              {step < 4 ? (
                <button class="btn primary" data-testid="next" onClick={() => go(step + 1)}>Next <Icon name="next" /></button>
              ) : (
                <button class="btn primary" data-testid="save" onClick={save}><Icon name="check" /> Save frame</button>
              )}
            </div>
          </div>
        )}
      </div>
      <div class="editor-head">
        <button class="btn icon-only glass" onClick={close} aria-label="Close"><Icon name="close" /></button>
        <Steps steps={STEPS} current={step} maxReached={maxStep} onGo={(i) => (i === 0 && existing ? null : go(i))} />
        {existing && step > 1 && <button class="btn primary" onClick={save}><Icon name="check" /> Save</button>}
      </div>
      {busy && <Busy text={busy} />}
    </div>
  );

  function addOpening(shape: 'rect' | 'oval') {
    const w = Math.min(5, wIn * 0.5), h = Math.min(7, hIn * 0.5);
    const o: Opening = { id: `o${uid()}`, x: (wIn - w) / 2, y: (hIn - h) / 2, w, h, shape };
    setOpenings([...openings, o]);
    setSelOpening(o.id);
    setOpeningsTouched(true);
  }

  async function ensureOpeningsForce(r: Straightened) {
    setBusy('Looking for openings…');
    await nextFrame();
    const d = detectOpenings(r.img, r.ppi, r.padX, r.padY, wIn, hIn);
    setOpenings(d.openings);
    setMatted(d.matted);
    setOpeningsTouched(true);
    setBusy(null);
  }

  function addTag() {
    const t = tagText.trim().toLowerCase();
    if (t && tags && !tags.custom.includes(t)) setTags({ ...tags, custom: [...tags.custom, t] });
    setTagText('');
  }
}

function fmtLen2(v: number, units: 'in' | 'cm') {
  return fmtSize(v, v, units).split(' × ')[0] + (units === 'cm' ? ' cm' : '″');
}

function knownTags(): string[] {
  const s = getState();
  return [...new Set([...s.frames.flatMap((f) => f.tags.custom), ...s.pictures.flatMap((p) => p.tags.custom)])].sort();
}

export const COLOR_SWATCH: Record<string, string> = {
  black: '#111', gray: '#888', silver: '#c0c0c8', white: '#f5f5f5', cream: '#efe4cc', gold: '#c9a13b', yellow: '#f2d23c',
  orange: '#f08a2c', wood: '#8a5a33', brown: '#6b4428', red: '#d33', pink: '#f28bb3', purple: '#8a5cd6', blue: '#3a7bd5', teal: '#2bb3a8', green: '#4caf50',
};

export function FineRotate({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div class="col" style={{ gap: 6 }}>
      <div class="row" style={{ justifyContent: 'space-between' }}>
        <span class="section-title" style={{ margin: 0 }}>Fine-tune rotation</span>
        <b>{value > 0 ? '+' : ''}{value}°</b>
      </div>
      <div class="row">
        <button class="btn icon-only" onClick={() => onChange(Math.round((value - 1) * 10) / 10)} aria-label="Rotate −1°"><Icon name="minus" /></button>
        <input type="range" min={-15} max={15} step={0.5} value={value} onInput={(e) => onChange(+(e.target as HTMLInputElement).value)} />
        <button class="btn icon-only" onClick={() => onChange(Math.round((value + 1) * 10) / 10)} aria-label="Rotate +1°"><Icon name="plus" /></button>
      </div>
      {value !== 0 && <button class="btn small ghost" onClick={() => onChange(0)}>Reset</button>}
    </div>
  );
}

/** The cut-out frame on a neutral background (used on the Details step). */
function FramePreview({ rect, outline }: { rect: Straightened; outline: Pt[] }) {
  const W = rect.img.width, H = rect.img.height;
  const clip = outline.map((p) => `${(((p.x + rect.padX) * rect.ppi) / W) * 100}% ${(((p.y + rect.padY) * rect.ppi) / H) * 100}%`).join(',');
  const scale = Math.min(1, 520 / Math.max(W, H));
  return (
    <div style={{ filter: 'drop-shadow(0 16px 30px rgba(0,0,0,0.6))' }}>
      <img src={rect.url} style={{ width: W * scale, height: H * scale, clipPath: `polygon(${clip})`, WebkitClipPath: `polygon(${clip})` }} />
    </div>
  );
}

export { Len };
