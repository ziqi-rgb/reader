import type { ReadingOverrides } from '../api/types.ts';
import type { BlobStore, KeyValueStore } from '../core/platform.ts';
import type { SessionCache } from './session-cache.ts';
import type { BookContent, Manifest, TocEntry } from '../api/types.ts';

/** One chapter a previous version of this client left on disk. */
export interface CachedResource { bookId: string; ref: string; bytes: number }
const writes = new Map<string, Promise<unknown>>();
export const OFFLINE_FILE = '__complete_file__';

/**
 * Device storage for a publication: its *metadata* on disk, its *text* in memory.
 *
 * The split is the point. Chapter text is not kept here at all — it lives in
 * `SessionCache`, which the browser drops when it closes. A reader who wants a
 * copy keeps it on the server (all their devices share it) or downloads a file;
 * a browser that quietly retained every chapter it had ever displayed was the
 * behaviour that made "只保存到正在访问的客机" true, and it was a bad trade: the
 * copy nobody asked for was the one nobody could find.
 *
 * What *is* persistent is small and derived: the manifest, the window list, the
 * table of contents, and the reader's own overlays. Those are what let a book
 * open instantly and remember how it was configured, and none of them is the book.
 *
 * The namespace includes both the server and the account: a book id is only
 * unique inside one account, and using it on its own would let signing out and
 * into another server expose the previous account's data.
 */
export class PublicationCache {
  private readonly scopeKey: string;

  constructor(
    private readonly kv: KeyValueStore,
    private readonly blobs: BlobStore,
    scope: string,
    /** The book's text as cached for this browser session only; see `SessionCache`. */
    private readonly session?: SessionCache,
  ) {
    this.scopeKey = encodeURIComponent(scope);
  }

  async manifest(bookId: string): Promise<Manifest | null> {
    const raw = await this.kv.get(this.metaKey(bookId));
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as Manifest;
      return value?.book?.id === bookId ? value : null;
    } catch {
      return null;
    }
  }

  async putManifest(bookId: string, manifest: Manifest): Promise<void> {
    await this.kv.set(this.metaKey(bookId), JSON.stringify(manifest));
  }

  /**
   * A chapter's bytes, from this browser session only.
   *
   * The persistent store is deliberately not consulted: text left on disk by an
   * older build is not something this client reads any more, so a reader is never
   * shown a chapter from a copy the panel says it does not keep.
   */
  async resource(bookId: string, ref: string): Promise<Uint8Array | null> {
    return this.session?.get(bookId, ref) ?? null;
  }

  /**
   * Keep a chapter for this browser session only.
   *
   * Returns whether the copy survived into `sessionStorage`; it lives in memory
   * either way. A single chapter fits comfortably — that is all this cache is for.
   */
  putSessionResource(bookId: string, ref: string, bytes: Uint8Array): boolean {
    return this.session?.put(bookId, ref, bytes) ?? false;
  }

  sessionBytes(bookId?: string): number {
    return this.session?.bytes(bookId) ?? 0;
  }

  clearSession(bookId?: string): void {
    this.session?.clear(bookId);
  }

  async overrides(bookId: string): Promise<ReadingOverrides | null> { const raw = await this.kv.get(this.metaKey(bookId) + ':overrides'); try { return raw ? JSON.parse(raw) as ReadingOverrides : null; } catch { return null; } }
  async putOverrides(bookId: string, value: ReadingOverrides): Promise<void> { await this.kv.set(this.metaKey(bookId) + ':overrides',JSON.stringify(value)); }
  async window(bookId: string, group: number): Promise<BookContent | null> {
    const raw = await this.kv.get(this.metaKey(bookId) + ':window:' + group);
    try { return raw ? JSON.parse(raw) as BookContent : null; } catch { return null; }
  }
  async putWindow(bookId: string, group: number, content: BookContent): Promise<void> {
    await this.kv.set(this.metaKey(bookId) + ':window:' + group, JSON.stringify(content));
  }
  async toc(bookId: string): Promise<TocEntry[] | null> {
    const value = await this.kv.get(this.metaKey(bookId) + ':toc');
    try { return value ? JSON.parse(value) as TocEntry[] : null; } catch { return null; }
  }
  async putToc(bookId: string, toc: TocEntry[]): Promise<void> { await this.kv.set(this.metaKey(bookId) + ':toc', JSON.stringify(toc)); }

  /**
   * Chapter text an earlier build left on this device.
   *
   * Read-only and kept only so it can be reported and deleted: nothing writes
   * here any more. A reader upgrading should be able to see what is still taking
   * space and clear it in one tap.
   */
  async entries(): Promise<CachedResource[]> {
    const raw = await this.kv.get(this.indexKey());
    if (raw) return JSON.parse(raw) as CachedResource[];
    // Older builds predate the index: adopt their blobs by key so the cleanup UI
    // is complete rather than showing an empty list over real files.
    const prefix = `reader.publication.resource.v1:${this.scopeKey}:`;
    const entries: CachedResource[] = [];
    for (const key of await this.blobs.list()) {
      if (!key.startsWith(prefix)) continue;
      const [book, ref] = key.slice(prefix.length).split(':');
      const bytes = await this.blobs.get(key);
      if (book && ref && bytes) entries.push({ bookId: decodeURIComponent(book), ref: decodeURIComponent(ref), bytes: bytes.byteLength });
    }
    return entries;
  }

  async removeBook(bookId: string): Promise<void> {
    await this.exclusive(async () => {
      const entries = await this.entries();
      for (const entry of entries.filter(e => e.bookId === bookId)) await this.blobs.remove(this.resourceKey(bookId, entry.ref));
      await this.kv.set(this.indexKey(), JSON.stringify(entries.filter(e => e.bookId !== bookId)));
      await this.kv.remove(this.metaKey(bookId) + ':task');
      // Keep the lightweight manifest and reading records; never delete the user's source file.
    });
  }
  private indexKey(): string { return `reader.publication.index.v1:${this.scopeKey}`; }
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const key = this.indexKey();
    const next = (writes.get(key) ?? Promise.resolve()).catch(() => undefined).then(action);
    writes.set(key, next);
    try { return await next; } finally { if (writes.get(key) === next) writes.delete(key); }
  }

  private metaKey(bookId: string): string {
    return `reader.publication.v1:${this.scopeKey}:${bookId}`;
  }

  private resourceKey(bookId: string, ref: string): string {
    return `reader.publication.resource.v1:${this.scopeKey}:${encodeURIComponent(bookId)}:${encodeURIComponent(ref)}`;
  }
}

export function publicationScope(serverUrl: string, userId: string): string {
  return JSON.stringify([serverUrl.replace(/\/+$/, ''), userId]);
}
