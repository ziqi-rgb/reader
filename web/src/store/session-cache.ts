/**
 * A chapter cache that ends when the browser does.
 *
 * Two layers, because the two failures are different:
 *
 *  - **memory** covers the current page, so re-reading a chapter in the same
 *    session never touches the network;
 *  - **`sessionStorage`** carries it across a reload, which is what a reader
 *    actually does (a refresh, a link opened in the same tab), and is dropped by
 *    the browser when the tab or window closes — which is the promise the panel
 *    makes.
 *
 * A write that does not fit (sessionStorage is a few megabytes) is not an error:
 * the bytes stay in memory and the caller is told they were not persisted, so a
 * long novel degrades to "this page" instead of failing the whole cache.
 *
 * Nothing here is user data that must survive: positions, notes and progress live
 * in `reader.db`; this is only a copy of the text.
 */
export class SessionCache {
  private readonly memory = new Map<string, Uint8Array>();
  private readonly prefix: string;

  constructor(scope: string) {
    this.prefix = `reader.session.chapter.v1:${encodeURIComponent(scope)}`;
  }

  get(bookId: string, ref: string): Uint8Array | null {
    const key = this.key(bookId, ref);
    const cached = this.memory.get(key);
    if (cached) return cached;
    const raw = storage()?.getItem(key);
    if (!raw) return null;
    const bytes = decodeBase64(raw);
    if (bytes) this.memory.set(key, bytes);
    return bytes;
  }

  /** Returns false when the bytes only live in memory (the session quota is full). */
  put(bookId: string, ref: string, bytes: Uint8Array): boolean {
    const key = this.key(bookId, ref);
    this.memory.set(key, bytes);
    const store = storage();
    if (!store) return false;
    try {
      store.setItem(key, encodeBase64(bytes));
      return true;
    } catch {
      // Quota exceeded, or storage disabled: keep the in-memory copy and let the
      // caller say the cache will not survive a reload, rather than throw away
      // what it just fetched.
      return false;
    }
  }

  clear(bookId?: string): void {
    const match = (key: string) => bookId === undefined || key.includes(`:${encodeURIComponent(bookId)}:`);
    for (const key of [...this.memory.keys()]) if (match(key)) this.memory.delete(key);
    const store = storage();
    if (!store) return;
    const keys: string[] = [];
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key?.startsWith(this.prefix) && match(key)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  }

  /** Bytes currently held, for the panel's usage line. */
  bytes(bookId?: string): number {
    let total = 0;
    for (const [key, value] of this.memory) if (bookId === undefined || key.includes(`:${encodeURIComponent(bookId)}:`)) total += value.byteLength;
    return total;
  }

  private key(bookId: string, ref: string): string {
    return `${this.prefix}:${encodeURIComponent(bookId)}:${encodeURIComponent(ref)}`;
  }
}

function storage(): Storage | null {
  try {
    const store = globalThis.sessionStorage;
    // Touch it: a browser in a restricted mode exposes the object but throws on use.
    const probe = `${'reader.session.probe'}:1`;
    store.setItem(probe, '1');
    store.removeItem(probe);
    return store;
  } catch {
    return null;
  }
}

/** Chunked, because `String.fromCharCode(...bytes)` overflows on a large chapter. */
function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let start = 0; start < bytes.length; start += chunk) {
    binary += String.fromCharCode(...bytes.subarray(start, start + chunk));
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}
