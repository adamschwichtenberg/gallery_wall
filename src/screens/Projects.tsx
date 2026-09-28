import { useRef, useState } from 'preact/hooks';
import { Icon } from '../components/Icon';
import { Modal, Segmented, Toggle, useBlobUrl } from '../components/ui';
import { exportBackup, importBackup, shareOrDownload } from '../lib/backup';
import { requestPersistence } from '../lib/db';
import { createProject, deleteProject, navigate, openModal, saveProject, setPrefs, toast, useStore } from '../lib/store';
import type { Project } from '../lib/types';

export function ProjectsScreen() {
  const projects = useStore((s) => s.projects);
  const frames = useStore((s) => s.frames.length);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');

  const create = async () => {
    const p = await createProject(name.trim() || `Wall ${projects.length + 1}`);
    setNaming(false);
    setName('');
    navigate({ name: 'project', id: p.id });
    openModal({ kind: 'wall', projectId: p.id });
  };

  return (
    <div class="screen">
      <div class="page-head">
        <div>
          <h1>Walls</h1>
          <div class="muted">Each wall keeps its own photo, paint and layouts</div>
        </div>
        <button class="btn primary" data-testid="new-wall" onClick={() => setNaming(true)}><Icon name="plus" /> New wall</button>
      </div>
      {projects.length === 0 ? (
        <div class="empty glass" style={{ borderRadius: 26, padding: '48px 24px' }}>
          <Icon name="wall" size={44} />
          <h2>Plan your first gallery wall</h2>
          <ol class="hint" style={{ textAlign: 'left', maxWidth: 440, lineHeight: 1.7 }}>
            <li><b>Photograph your wall</b> and pin a rectangle you’ve measured.</li>
            <li><b>Add your frames</b>{frames ? ` (you have ${frames})` : ''}: photo and outside size. They’re cut out automatically.</li>
            <li><b>Arrange</b>: drag, snap, swap pictures, and let autofill suggest layouts.</li>
          </ol>
          <button class="btn primary" onClick={() => setNaming(true)}><Icon name="camera" /> Start with your wall</button>
        </div>
      ) : (
        <div class="card-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
          {projects.map((p) => <ProjectCard key={p.id} p={p} />)}
        </div>
      )}
      {naming && (
        <Modal onClose={() => setNaming(false)}>
          <h2>New wall</h2>
          <form class="col" onSubmit={(e) => { e.preventDefault(); create(); }}>
            <input class="input" autoFocus placeholder="e.g. Hallway, Living room" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
            <div class="row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" class="btn" onClick={() => setNaming(false)}>Cancel</button>
              <button type="submit" class="btn primary" data-testid="create-wall">Create & add photo</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

function ProjectCard({ p }: { p: Project }) {
  const url = useBlobUrl(p.thumbBlobId ?? p.wall?.imageBlobId);
  const items = p.layouts.reduce((a, l) => Math.max(a, l.items.length), 0);
  const [menu, setMenu] = useState(false);
  const [name, setName] = useState(p.name);
  return (
    <div class="card glass" onClick={() => navigate({ name: 'project', id: p.id })}>
      <div class="thumb cover" style={{ aspectRatio: '4 / 3' }}>{url ? <img src={url} /> : <Icon name="wall" size={40} />}</div>
      <div class="row">
        <div class="grow">
          <div style={{ fontWeight: 650, fontSize: 17 }}>{p.name}</div>
          <div class="name">{p.layouts.length} layout{p.layouts.length === 1 ? '' : 's'} · {items} frame{items === 1 ? '' : 's'} · {new Date(p.updatedAt).toLocaleDateString()}</div>
        </div>
        <button class="btn small icon-only ghost" aria-label="More" onClick={(e) => { e.stopPropagation(); setName(p.name); setMenu(true); }}>
          <Icon name="more" />
        </button>
      </div>
      {menu && (
        <div onClick={(e) => e.stopPropagation()}>
          <Modal onClose={() => setMenu(false)}>
            <h2>Wall settings</h2>
            <form class="col" onSubmit={(e) => { e.preventDefault(); if (name.trim()) saveProject({ ...p, name: name.trim() }); setMenu(false); }}>
              <label class="field"><span>Name</span><input class="input" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} /></label>
              <div class="row">
                <button type="button" class="btn danger" onClick={() => { if (confirm(`Delete “${p.name}” and all its layouts? Your frames and pictures are kept.`)) { deleteProject(p.id); setMenu(false); } }}><Icon name="trash" /> Delete wall</button>
                <div class="grow" />
                <button type="button" class="btn" onClick={() => setMenu(false)}>Cancel</button>
                <button type="submit" class="btn primary">Save</button>
              </div>
            </form>
          </Modal>
        </div>
      )}
    </div>
  );
}

export function SettingsModal() {
  const prefs = useStore((s) => s.prefs);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  return (
    <Modal onClose={() => openModal(null)}>
      <div class="row" style={{ justifyContent: 'space-between' }}>
        <h2>Settings</h2>
        <button class="btn icon-only small" onClick={() => openModal(null)}><Icon name="close" /></button>
      </div>
      <div class="row" style={{ justifyContent: 'space-between' }}>
        <span>Units</span>
        <Segmented value={prefs.units} onChange={(units) => setPrefs({ units })} options={[{ value: 'in', label: 'Inches (¼″)' }, { value: 'cm', label: 'Centimeters' }]} />
      </div>
      <Toggle label="Reduce transparency" on={prefs.reduceTransparency} onChange={(v) => setPrefs({ reduceTransparency: v })} />
      <div class="section-title">Your data</div>
      <div class="hint">
        Everything is saved <b>on this device only</b>: nothing is uploaded. Add the app to your Home Screen so iPadOS keeps its storage, and export a backup now and then (e.g. to Files or iCloud Drive) to move data to another device.
      </div>
      <div class="row wrap">
        <button class="btn" disabled={busy} onClick={async () => {
          setBusy(true);
          try { await shareOrDownload(await exportBackup(), `gallery-wall-backup-${new Date().toISOString().slice(0, 10)}.zip`); }
          finally { setBusy(false); }
        }}><Icon name="download" /> Export backup</button>
        <button class="btn" disabled={busy} onClick={() => input.current?.click()}><Icon name="upload" /> Import backup</button>
        <button class="btn ghost small" onClick={async () => setPersisted(await requestPersistence())}>Check storage</button>
      </div>
      {persisted !== null && <div class="small-text muted">{persisted ? 'Storage is marked persistent.' : 'The browser didn’t confirm persistent storage — keep backups, or add to Home Screen.'}</div>}
      <input ref={input} type="file" accept=".zip,application/zip" hidden onChange={async (e) => {
        const f = (e.target as HTMLInputElement).files?.[0];
        (e.target as HTMLInputElement).value = '';
        if (!f) return;
        setBusy(true);
        try {
          const r = await importBackup(f);
          toast(`Imported ${r.frames} frames, ${r.pictures} pictures, ${r.projects} walls`);
        } catch (err) {
          toast(`Import failed: ${(err as Error).message}`);
        } finally { setBusy(false); }
      }} />
    </Modal>
  );
}
