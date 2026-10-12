const DB_NAME = "shorts-analyzer";
const STORE = "videos";
const KEY = "current";

type StoredVideo = {
  fingerprint: string;
  name: string;
  type: string;
  blob: Blob;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function persistVideoBlob(file: File, fingerprint: string) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(STORE).put(
      { fingerprint, name: file.name, type: file.type || "video/mp4", blob: file } satisfies StoredVideo,
      KEY,
    );
  });
  db.close();
}

export async function loadVideoBlob(): Promise<StoredVideo | null> {
  const db = await openDb();
  const value = await new Promise<StoredVideo | null>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).get(KEY);
    request.onsuccess = () => resolve((request.result as StoredVideo | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return value;
}
