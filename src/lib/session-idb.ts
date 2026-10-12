const DB_NAME = "shorts-analyzer";
const DB_VERSION = 2;
const VIDEO_STORE = "videos";
const RESULT_STORE = "results";
const CURRENT_KEY = "current";

export const FINGERPRINT_CACHE_KEY = "shorts-analyzer-by-fingerprint";

type StoredVideo = {
  fingerprint: string;
  name: string;
  type: string;
  blob: Blob;
};

type StoredAnalysis = {
  fingerprint: string;
  result: unknown;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(VIDEO_STORE)) db.createObjectStore(VIDEO_STORE);
      if (!db.objectStoreNames.contains(RESULT_STORE)) db.createObjectStore(RESULT_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function removeOversizedFingerprintCache() {
  for (const storage of [globalThis.sessionStorage, globalThis.localStorage]) {
    try {
      storage?.removeItem(FINGERPRINT_CACHE_KEY);
    } catch {
      /* ignore */
    }
  }
}

export function isQuotaError(error: unknown) {
  return (
    error instanceof DOMException &&
    (error.name === "QuotaExceededError" || error.code === 22 || error.code === 1014)
  );
}

export function safeStorageSet(storage: Storage, key: string, value: string) {
  try {
    storage.setItem(key, value);
  } catch (error) {
    if (isQuotaError(error)) {
      removeOversizedFingerprintCache();
      return false;
    }
    throw error;
  }
  return true;
}

export async function persistVideoBlob(file: File, fingerprint: string) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(VIDEO_STORE, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(VIDEO_STORE).put(
      { fingerprint, name: file.name, type: file.type || "video/mp4", blob: file } satisfies StoredVideo,
      CURRENT_KEY,
    );
  });
  db.close();
}

export async function loadVideoBlob(): Promise<StoredVideo | null> {
  const db = await openDb();
  const value = await new Promise<StoredVideo | null>((resolve, reject) => {
    const tx = db.transaction(VIDEO_STORE, "readonly");
    const request = tx.objectStore(VIDEO_STORE).get(CURRENT_KEY);
    request.onsuccess = () => resolve((request.result as StoredVideo | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return value;
}

export async function persistAnalysisRecord(result: unknown, fingerprint: string) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(RESULT_STORE, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    const record: StoredAnalysis = { fingerprint, result };
    tx.objectStore(RESULT_STORE).put(record, CURRENT_KEY);
    tx.objectStore(RESULT_STORE).put(record, fingerprint);
  });
  db.close();
}

export async function loadAnalysisRecord(fingerprint?: string): Promise<StoredAnalysis | null> {
  const db = await openDb();
  const value = await new Promise<StoredAnalysis | null>((resolve, reject) => {
    const tx = db.transaction(RESULT_STORE, "readonly");
    const request = tx.objectStore(RESULT_STORE).get(fingerprint || CURRENT_KEY);
    request.onsuccess = () => resolve((request.result as StoredAnalysis | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return value;
}
