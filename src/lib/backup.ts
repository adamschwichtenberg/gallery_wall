// Export / import everything as a single .zip — the safety net for on-device storage.
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { dbAll, dbGet, dbKeys, dbPut, getBlob } from './db';
import { loadAll } from './store';
import type { Frame, Picture, Prefs, Project } from './types';

interface Manifest { version: 1; exportedAt: number; frames: Frame[]; pictures: Picture[]; projects: Project[]; prefs?: Prefs; blobs: Record<string, string> }

export async function exportBackup(): Promise<Blob> {
  const [frames, pictures, projects, prefs, keys] = await Promise.all([
    dbAll<Frame>('frames'), dbAll<Picture>('pictures'), dbAll<Project>('projects'), dbGet<Prefs>('kv', 'prefs'), dbKeys('blobs'),
  ]);
  const files: Record<string, Uint8Array> = {};
  const blobs: Record<string, string> = {};
  for (const k of keys) {
    const b = await getBlob(k);
    if (!b) continue;
    files[`blobs/${k}`] = new Uint8Array(await b.arrayBuffer());
    blobs[k] = b.type;
  }
  const manifest: Manifest = { version: 1, exportedAt: Date.now(), frames, pictures, projects, prefs, blobs };
  files['manifest.json'] = strToU8(JSON.stringify(manifest));
  // Images are already compressed; store them without re-deflating.
  const zipped = zipSync(files, { level: 0 });
  return new Blob([zipped as unknown as BlobPart], { type: 'application/zip' });
}

export async function importBackup(file: Blob): Promise<{ frames: number; pictures: number; projects: number }> {
  const data = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const m = JSON.parse(strFromU8(data['manifest.json'])) as Manifest;
  if (m.version !== 1) throw new Error('Unrecognised backup file');
  for (const [k, type] of Object.entries(m.blobs)) {
    const bytes = data[`blobs/${k}`];
    if (bytes) await dbPut('blobs', k, new Blob([bytes as unknown as BlobPart], { type }));
  }
  for (const f of m.frames) await dbPut('frames', f.id, f);
  for (const p of m.pictures) await dbPut('pictures', p.id, p);
  for (const p of m.projects) await dbPut('projects', p.id, p);
  await loadAll();
  return { frames: m.frames.length, pictures: m.pictures.length, projects: m.projects.length };
}

/** Save or share a file (uses the iPad share sheet when available). */
export async function shareOrDownload(blob: Blob, filename: string) {
  const file = new File([blob], filename, { type: blob.type });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: filename });
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
