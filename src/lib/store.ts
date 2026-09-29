// App state: a small observable store backed by IndexedDB.
import { useEffect, useState } from 'preact/hooks';
import { dbAll, dbDelete, dbGet, dbPut, deleteBlob, uid } from './db';
import type { Frame, Layout, Picture, Prefs, Project } from './types';

export type Route =
  | { name: 'projects' }
  | { name: 'frames' }
  | { name: 'pictures' }
  | { name: 'project'; id: string };

export type Modal =
  | { kind: 'frame'; id?: string }
  | { kind: 'picture'; id?: string }
  | { kind: 'wall'; projectId: string }
  | { kind: 'vantage'; projectId: string; id?: string }
  | { kind: 'settings' }
  | null;

export interface State {
  ready: boolean;
  frames: Frame[];
  pictures: Picture[];
  projects: Project[];
  prefs: Prefs;
  route: Route;
  modal: Modal;
  toast: { text: string; id: number } | null;
}

let state: State = {
  ready: false,
  frames: [],
  pictures: [],
  projects: [],
  prefs: { units: 'in', reduceTransparency: false },
  route: { name: 'projects' },
  modal: null,
  toast: null,
};

const listeners = new Set<() => void>();

export function getState() {
  return state;
}

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  listeners.forEach((l) => l());
}

export function useStore<T>(sel: (s: State) => T): T {
  const [, force] = useState(0);
  useEffect(() => {
    let prev = sel(state);
    const l = () => {
      const next = sel(state);
      if (next !== prev) {
        prev = next;
        force((n) => n + 1);
      }
    };
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return sel(state);
}

export async function loadAll() {
  const [frames, pictures, projects, prefs] = await Promise.all([
    dbAll<Frame>('frames'),
    dbAll<Picture>('pictures'),
    dbAll<Project>('projects'),
    dbGet<Prefs>('kv', 'prefs'),
  ]);
  setState({
    ready: true,
    frames: frames.sort((a, b) => b.createdAt - a.createdAt),
    pictures: pictures.sort((a, b) => b.createdAt - a.createdAt),
    projects: projects.sort((a, b) => b.updatedAt - a.updatedAt),
    prefs: { ...state.prefs, ...prefs },
  });
  // Restore the last screen.
  const last = await dbGet<Route>('kv', 'route');
  if (last && (last.name !== 'project' || projects.some((p) => p.id === last.id))) setState({ route: last });
}

export function navigate(route: Route) {
  setState({ route });
  void dbPut('kv', 'route', route);
}

export function openModal(modal: Modal) {
  setState({ modal });
}

let toastId = 0;
export function toast(text: string) {
  const id = ++toastId;
  setState({ toast: { text, id } });
  setTimeout(() => {
    if (state.toast?.id === id) setState({ toast: null });
  }, 2600);
}

export async function setPrefs(p: Partial<Prefs>) {
  const prefs = { ...state.prefs, ...p };
  setState({ prefs });
  await dbPut('kv', 'prefs', prefs);
}

// ---- Frames & pictures ------------------------------------------------------

export async function saveFrame(f: Frame) {
  await dbPut('frames', f.id, f);
  setState((s) => ({ frames: upsert(s.frames, f) }));
}

export async function deleteFrame(id: string) {
  const f = state.frames.find((x) => x.id === id);
  if (!f) return;
  await dbDelete('frames', id);
  await deleteBlob(f.imageBlobId);
  await deleteBlob(f.straighten?.sourceBlobId);
  setState((s) => ({ frames: s.frames.filter((x) => x.id !== id) }));
  // Remove it from every layout.
  for (const p of state.projects) {
    if (p.layouts.some((l) => l.items.some((i) => i.frameId === id))) {
      await saveProject({ ...p, layouts: p.layouts.map((l) => ({ ...l, items: l.items.filter((i) => i.frameId !== id) })) });
    }
  }
}

export async function savePicture(p: Picture) {
  await dbPut('pictures', p.id, p);
  setState((s) => ({ pictures: upsert(s.pictures, p) }));
}

export async function deletePicture(id: string) {
  const p = state.pictures.find((x) => x.id === id);
  if (!p) return;
  await dbDelete('pictures', id);
  await deleteBlob(p.imageBlobId);
  await deleteBlob(p.straighten?.sourceBlobId);
  setState((s) => ({ pictures: s.pictures.filter((x) => x.id !== id) }));
  for (const pr of state.projects) {
    const used = pr.layouts.some((l) => l.items.some((i) => Object.values(i.fills).some((f) => f.pictureId === id)));
    if (!used) continue;
    await saveProject({
      ...pr,
      layouts: pr.layouts.map((l) => ({
        ...l,
        items: l.items.map((i) => ({
          ...i,
          fills: Object.fromEntries(Object.entries(i.fills).filter(([, f]) => f.pictureId !== id)),
        })),
      })),
    });
  }
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [item, ...list];
  const copy = list.slice();
  copy[i] = item;
  return copy;
}

// ---- Projects -------------------------------------------------------------------

export function newLayout(name = 'Layout 1'): Layout {
  return { id: uid(), name, items: [], updatedAt: Date.now() };
}

export async function createProject(name: string): Promise<Project> {
  const layout = newLayout();
  const p: Project = {
    id: uid(),
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    zones: [],
    layouts: [layout],
    activeLayoutId: layout.id,
    settings: { eyeLevel: 57, showEyeLevel: true, gap: 2, snap: true, showZones: true, showPaint: true },
  };
  await saveProject(p);
  return p;
}

const pendingSaves = new Map<string, ReturnType<typeof setTimeout>>();

/** Update in memory immediately; persist (debounced) in the background. */
export function saveProject(p: Project, immediate = true): Promise<void> {
  const next = { ...p, updatedAt: Date.now() };
  setState((s) => ({ projects: upsert(s.projects, next) }));
  clearTimeout(pendingSaves.get(p.id));
  if (immediate) return dbPut('projects', p.id, next);
  pendingSaves.set(p.id, setTimeout(() => void dbPut('projects', p.id, getProject(p.id) ?? next), 400));
  return Promise.resolve();
}

export function getProject(id: string) {
  return state.projects.find((p) => p.id === id);
}

export async function deleteProject(id: string) {
  const p = getProject(id);
  if (!p) return;
  await dbDelete('projects', id);
  await deleteBlob(p.wall?.imageBlobId);
  await deleteBlob(p.wall?.sourceBlobId);
  await deleteBlob(p.wall?.paintedBlobId);
  await deleteBlob(p.thumbBlobId);
  setState((s) => ({ projects: s.projects.filter((x) => x.id !== id) }));
}

export function activeLayout(p: Project): Layout {
  return p.layouts.find((l) => l.id === p.activeLayoutId) ?? p.layouts[0];
}

// Flush debounced saves when the app is backgrounded (iPad multitasking, closing the app).
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    for (const [id, t] of pendingSaves) {
      clearTimeout(t);
      const p = getProject(id);
      if (p) void dbPut('projects', id, p);
    }
    pendingSaves.clear();
  });
}
