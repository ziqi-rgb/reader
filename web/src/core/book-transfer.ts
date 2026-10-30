import type { ReaderApi } from '../api/client.ts';
import type { Manifest } from '../api/types.ts';
import { OFFLINE_FILE, PublicationCache } from '../store/publications.ts';
import type { SessionCache } from '../store/session-cache.ts';
import { renditionRef } from '../ui/rendition.ts';

/**
 * Where a book's bytes are sent, and in what order.
 *
 * The three destinations are not three implementations of one thing — they answer
 * three different questions:
 *
 *  - **server** — "keep it on my NAS": the upstream site is asked once per
 *    chapter and the text is written where every device reads it from afterwards.
 *  - **session** — "keep it in this browser until I close it": the server caches
 *    first (that is what makes the copy cheap), then the chapters are pulled into
 *    a `sessionStorage`-backed cache that the browser drops with the tab.
 *  - **download** — "give me a file": a chapter-per-file zip for a source novel,
 *    the book's own file for anything that already is one.
 *
 * The order matters and is the point of this class: the two client-side
 * destinations both go *through* the server, so a chapter is fetched from the
 * upstream site once rather than once per device and once per cleared cache.
 */
export type TransferMode = 'server' | 'session' | 'download';

export interface TransferState {
  status: 'idle' | 'running' | 'paused' | 'complete' | 'error';
  mode: TransferMode | null;
  /** Chapters (or the whole file) handled in this run. */
  completed: number;
  total: number;
  message: string;
  failed: Array<{ title: string; code: string }>;
  /** Chapters this server now holds for the book, when it can hold chapters. */
  serverChapters?: number;
  /** True when the session copy could not be persisted and lives in memory only. */
  sessionPartial?: boolean;
}

/** Defaults the cache panel starts from; the reader can change all three per run. */
export const TRANSFER_TIMEOUT_MIN_MS = 5_000;
export const TRANSFER_TIMEOUT_MAX_MS = 300_000;
export const TRANSFER_TIMEOUT_DEFAULT_MS = 60_000;
export const TRANSFER_CONCURRENCY_MAX = 4;
export const TRANSFER_CONCURRENCY_DEFAULT = 2;
export const TRANSFER_DELAY_MAX_MS = 10_000;
export const TRANSFER_DELAY_DEFAULT_MS = 0;

export interface TransferOptions {
  /** Deadline for one chapter's fetch from the upstream source. */
  timeoutMs?: number;
  /**
   * Chapters in flight at once.
   *
   * The source host admits two concurrent calls per source instance, so a larger
   * number mostly buys queueing at the server (and a `RATE_LIMITED` retry); a
   * smaller one is the polite option for a site that dislikes bursts.
   */
  concurrency?: number;
  /** Pause before each chapter, in milliseconds — for slow or rate-limiting sites. */
  delayMs?: number;
}

export class BookTransfer {
  state: TransferState = { status: 'idle', mode: null, completed: 0, total: 0, message: '', failed: [] };
  private run: AbortController | null = null;
  private pending: Promise<void> = Promise.resolve();
  private readonly perChapterOption: boolean | undefined;

  constructor(
    private readonly api: ReaderApi,
    private readonly cache: PublicationCache,
    private readonly session: SessionCache,
    private readonly manifest: Manifest,
    private readonly changed: (state: TransferState) => void,
    options: { perChapter?: boolean } = {},
  ) {
    this.perChapterOption = options.perChapter;
  }

  /**
   * Whether this book's content is addressed chapter by chapter.
   *
   * The caller may know better than the manifest: a TXT whose chapters the reader
   * defined locally cannot be addressed by the server's references at all, so it
   * is cached as one file even though the manifest has a chapter list.
   */
  get perChapter(): boolean {
    if (this.perChapterOption !== undefined) return this.perChapterOption;
    const book = this.manifest.book;
    return (book.format === 'chapters' || book.format === 'txt') && !!this.manifest.content;
  }

  /** Whether the upstream has to be asked at all — a local file is already here. */
  get fetchesUpstream(): boolean {
    return this.manifest.book.format === 'chapters';
  }

  /** What the server holds right now, for the panel's own line. */
  async serverInfo(): Promise<import('../api/types.ts').ChapterCacheInfo | null> {
    if (!this.fetchesUpstream) return null;
    try {
      return await this.api.chapterCache(this.manifest.book.id);
    } catch {
      return null;
    }
  }

  async clearServer(): Promise<number> {
    const result = await this.api.clearChapterCache(this.manifest.book.id);
    return result.removed;
  }

  async start(mode: TransferMode, from?: number, to?: number, options: TransferOptions = {}): Promise<void> {
    if (this.run) return;
    const run = this.run = new AbortController();
    this.pending = this.transfer(run, mode, from, to, options).finally(() => { if (this.run === run) this.run = null; });
    await this.pending;
  }

  /** Stop the current run; what was already written stays written. */
  async pause(): Promise<void> {
    this.run?.abort();
    this.run = null;
    await this.pending;
    this.update({ status: 'paused', message: '已停止，已保存的内容保留' });
  }

  private update(patch: Partial<TransferState>): void {
    this.state = { ...this.state, ...patch };
    this.changed({ ...this.state });
  }

  private async transfer(run: AbortController, mode: TransferMode, from?: number, to?: number, options: TransferOptions = {}): Promise<void> {
    const signal = run.signal;
    const total = this.manifest.content?.total ?? 0;
    const start = Math.max(1, from ?? 1);
    const end = Math.max(start, to ?? (this.perChapter ? total || 1 : 1));
    try {
      // A comic stored as a folder has no single file to download or cache: its
      // pages are the book, and there is no archive to hand out.
      if (this.manifest.book.format === 'image' && this.manifest.files.length > 1) throw new Error('图片目录暂不支持整书缓存或下载');
      if (mode === 'download') {
        await this.download(run, start, end, options);
        return;
      }
      this.update({ status: 'running', mode, completed: 0, total: this.perChapter ? end - start + 1 : 1, message: '正在准备', failed: [] });
      // A source novel is cached on the server first, for both destinations: that
      // is what makes the second request cheap and the copy durable.
      if (this.fetchesUpstream) await this.cacheOnServer(start, end, signal, options);
      if (mode === 'server') {
        // The message comes from the run itself ("已有缓存" vs "已保存"), and the
        // count is whichever is larger: the server's own total, or what this run
        // just wrote, so a server that answers slowly cannot make the panel go
        // backwards.
        const info = await this.serverInfo();
        this.update({ status: 'complete', serverChapters: Math.max(info?.chapters ?? 0, this.state.serverChapters ?? 0) });
        return;
      }
      if (mode === 'session') {
        await this.fillSession(start, end, signal);
        this.update({ status: 'complete', message: this.state.sessionPartial ? '已缓存到浏览器（容量不足，部分只在当前页面）' : '已缓存到浏览器，关闭浏览器即清除' });
      }
    } catch (error) {
      if (signal.aborted) return;
      this.update({ status: 'error', message: error instanceof Error ? error.message : '操作失败，可重试' });
    }
  }

  /**
   * Fetch the range into the server's own storage, skipping what is already there.
   *
   * One chapter per request, two in flight: the panel's "已缓存 N 章" then moves
   * as each chapter lands instead of jumping once at the end, and the source still
   * sees the same two concurrent calls a batched request would have made (the
   * server's per-request concurrency limit is two anyway).
   *
   * The gap check is the point of asking the server first: "缓存到浏览器" and
   * "下载到本地" both run this, and a reader who cached the book yesterday must not
   * make the server walk 900 chapters again — let alone ask the source.
   */
  private async cacheOnServer(from: number, to: number, signal: AbortSignal, options: TransferOptions = {}): Promise<void> {
    const book = this.manifest.book;
    this.update({ completed: 0, total: to - from + 1, message: '正在检查服务器缓存' });
    const known = new Set((await this.serverInfo())?.indexes ?? []);
    const missing: number[] = [];
    for (let chapter = from; chapter <= to; chapter += 1) if (!known.has(chapter)) missing.push(chapter);
    const span = to - from + 1;
    if (missing.length === 0) {
      this.update({ completed: span, total: span, serverChapters: known.size, message: '服务器已有这段缓存，未重复下载' });
      return;
    }
    let cached = known.size;
    let handled = span - missing.length;
    const failed: Array<{ title: string; code: string }> = [];
    this.update({ completed: handled, total: span, serverChapters: cached, message: `正在下载到服务器（${handled}/${span}）` });
    let cursor = 0;
    const concurrency = Math.max(1, Math.min(TRANSFER_CONCURRENCY_MAX, Math.round(options.concurrency ?? TRANSFER_CONCURRENCY_DEFAULT)));
    const delayMs = Math.max(0, Math.min(TRANSFER_DELAY_MAX_MS, Math.round(options.delayMs ?? TRANSFER_DELAY_DEFAULT_MS)));
    let started = 0;
    const workers = Array.from({ length: Math.min(concurrency, missing.length) }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        const chapter = missing[index];
        if (chapter === undefined) return;
        signal.throwIfAborted();
        // A pause before each chapter (not after the last of a worker) is what makes
        // a bursty source survive a 900-chapter run; zero means "as fast as allowed".
        if (delayMs > 0 && started > 0) await pause(delayMs, signal);
        started += 1;
        const batch = await this.api.cacheChapters(book.id, chapter, chapter, {
          signal,
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        });
        cached += batch.cached;
        handled += 1;
        failed.push(...batch.failed);
        // After every chapter, not every batch: this line is the reader's only
        // evidence that a long download is making progress.
        this.update({ completed: handled, total: span, serverChapters: cached, failed: [...failed], message: `正在下载到服务器（${cached} 章 · ${handled}/${span}）` });
      }
    });
    await Promise.all(workers);
    signal.throwIfAborted();
    this.update({
      failed,
      serverChapters: cached,
      completed: span,
      total: span,
      message: failed.length ? `${cached} 章已保存到服务器，${failed.length} 章失败` : `${cached} 章已保存到服务器`,
    });
  }

  /** Pull the range from this server into the session cache. */
  private async fillSession(from: number, to: number, signal: AbortSignal): Promise<void> {
    const book = this.manifest.book;
    if (!this.perChapter) {
      // A single-file book has one addressable thing: the file itself.
      this.update({ message: '正在缓存整本文件' });
      const bytes = await this.cache.resource(book.id, OFFLINE_FILE) ?? await this.api.bookBytes(book.id, { signal });
      signal.throwIfAborted();
      const persisted = this.session.put(book.id, OFFLINE_FILE, bytes);
      this.update({ completed: 1, total: 1, sessionPartial: !persisted });
      return;
    }
    const content = this.manifest.content!;
    const items = [];
    for (let group = 0; group < Math.max(1, content.groups.length); group++) {
      signal.throwIfAborted();
      const shape = content.groups[group];
      if (shape && (shape.offset >= to || shape.offset + shape.count < from)) continue;
      const window = group === (content.group ?? 0) ? content : await this.api.items(book.id, group, { signal });
      items.push(...window.items.filter((item) => item.seq >= from - 1 && item.seq < to));
    }
    // A directory that no longer matches the run: fetch what we have rather than
    // failing, and say so through the count.
    let persisted = true;
    this.update({ completed: 0, total: items.length, message: '正在缓存到浏览器' });
    for (const [index, item] of items.entries()) {
      signal.throwIfAborted();
      const ref = renditionRef(item);
      if (!this.session.get(book.id, ref)) {
        const blob = await this.api.asset(book.id, ref, { signal });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        signal.throwIfAborted();
        if (!this.session.put(book.id, ref, bytes)) persisted = false;
      }
      this.update({ completed: index + 1, sessionPartial: !persisted });
    }
  }

  private async download(run: AbortController, from: number, to: number, options: TransferOptions = {}): Promise<void> {
    const book = this.manifest.book, signal = run.signal;
    if (this.fetchesUpstream) {
      this.update({ status: 'running', mode: 'download', completed: 0, total: to - from + 1, message: '正在下载到服务器', failed: [] });
      await this.cacheOnServer(from, to, signal, options);
      signal.throwIfAborted();
      this.update({ message: '正在打包下载' });
      const zip = await this.api.chapterCacheZip(book.id, { signal });
      signal.throwIfAborted();
      saveBlob(zip, `${book.title || 'book'}.zip`);
      this.update({ status: 'complete', message: '已下载到本地（每章一个 txt 的 zip）' });
      return;
    }
    this.update({ status: 'running', mode: 'download', completed: 0, total: 1, message: '正在下载文件', failed: [] });
    const bytes = await this.api.bookBytes(book.id, { signal });
    signal.throwIfAborted();
    saveBlob(new Blob([toArrayBuffer(bytes)]), fileNameOf(this.manifest, book.title));
    this.update({ status: 'complete', completed: 1, message: '已下载到本地' });
  }
}

function fileNameOf(manifest: Manifest, fallback: string): string {
  const relPath = manifest.files.find((file) => file.missing === 0)?.rel_path ?? manifest.files[0]?.rel_path;
  const name = relPath?.split('/').pop();
  return name && name.trim() ? name : fallback || 'book';
}

/** Waits, but gives up the moment the run is stopped. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    const cancel = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', cancel, { once: true });
  });
}

/** Hand a blob to the browser's own download path, then release the URL. */
function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  anchor.click();
  // Revoked on a later turn of the event loop: revoking synchronously can cancel
  // the download the click just started.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
