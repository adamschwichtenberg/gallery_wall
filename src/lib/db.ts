// Tiny IndexedDB wrapper. Everything lives on-device; nothing is uploaded.

const DB_NAME = 'gallery-wall';
const DB_VERSION = 1;
export const STORES = ['frames', 'pictures', 'projects', 'blobs', 'kv'] as const;
export type StoreName = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function dbGet<T>(store: StoreName, key: string): Promise<T | undefined> {
  const db = await open();
  return wrap(db.transaction(store).objectStore(store).get(key)) as Promise<T | undefined>;
}

export async function dbPut(store: StoreName, key: string, value: unknown): Promise<void> {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value, key);
  await new Promise<void>((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });
}

export async function dbDelete(store: StoreName, key: string): Promise<void> {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await new Promise<void>((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

export async function dbAll<T>(store: StoreName): Promise<T[]> {
  const db = await open();
  return wrap(db.transaction(store).objectStore(store).getAll()) as Promise<T[]>;
}

export async function dbKeys(store: StoreName): Promise<string[]> {
  const db = await open();
  return wrap(db.transaction(store).objectStore(store).getAllKeys()) as Promise<string[]>;
}

export async function dbClear(store: StoreName): Promise<void> {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).clear();
  await new Promise<void>((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

/** Ask the browser not to evict our data. Home-screen web apps on iOS are already exempt. */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

// ---- Blobs with an object-URL cache ---------------------------------------

const urlCache = new Map<string, string>();

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export async function putBlob(blob: Blob, id = uid()): Promise<string> {
  await dbPut('blobs', id, blob);
  return id;
}

export async function getBlob(id: string): Promise<Blob | undefined> {
  return dbGet<Blob>('blobs', id);
}

export async function blobUrl(id: string | undefined): Promise<string | undefined> {
  if (!id) return undefined;
  const hit = urlCache.get(id);
  if (hit) return hit;
  const b = await getBlob(id);
  if (!b) return undefined;
  const url = URL.createObjectURL(b);
  urlCache.set(id, url);
  return url;
}

export function cachedBlobUrl(id: string | undefined): string | undefined {
  return id ? urlCache.get(id) : undefined;
}

export async function deleteBlob(id: string | undefined): Promise<void> {
  if (!id) return;
  const url = urlCache.get(id);
  if (url) URL.revokeObjectURL(url);
  urlCache.delete(id);
  await dbDelete('blobs', id);
}
