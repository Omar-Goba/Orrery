export function readJSON<T>(storage: Storage, key: string): T | null {
  try {
    const raw = storage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeJSON(storage: Storage, key: string, value: unknown): void {
  storage.setItem(key, JSON.stringify(value));
}
