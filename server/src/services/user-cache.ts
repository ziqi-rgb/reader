import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveInside } from '../lib/paths.ts';

/** One chapter as it sits in the server-side cache. */
export interface CachedChapter { index: number; name: string; bytes: number }

/** A chapter file, ready to be put in an archive. */
export interface CachedChapterFile { name: string; data: Buffer }

/**
 * Chapter text the reader asked *this server* to keep, under DATA_DIR.
 *
 * Three things make this worth a directory of its own rather than a database
 * column:
 *
 * 1. **It is per account.** Two readers can cache the same book without seeing
 *    each other's copy, and signing out ends the association — the path starts
 *    with the user id.
 * 2. **It is the download.** "下载到本地" hands the reader a zip of exactly these
 *    files, so what the export contains is what the cache holds, not a second
 *    rendering that could drift from it.
 * 3. **It survives a re-scan and a restart.** A book whose upstream directory
 *    changed does not invalidate a chapter the reader already asked for; the
 *    files are named by their position and title, and nothing here depends on
 *    the database.
 *
 * The upstream *fetch* is cached separately (`chapter_resources`), which is what
 * keeps reading fast. This is the reader's own copy.
 */
export class UserChapterCache {
  constructor(private readonly dataDir: string) {}

  /** `DATA_DIR/user-cache/<userId>/<bookId>`; both segments are validated. */
  dir(userId: string, bookId: string): string {
    return resolveInside(this.dataDir, join('user-cache', segment(userId), segment(bookId)));
  }

  async write(userId: string, bookId: string, index: number, title: string, text: string): Promise<void> {
    const dir = this.dir(userId, bookId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, fileName(index, title)), text, 'utf8');
  }

  async list(userId: string, bookId: string): Promise<CachedChapter[]> {
    const dir = this.dir(userId, bookId);
    let names: string[];
    try {
      names = (await readdir(dir)).filter((name) => name.endsWith('.txt'));
    } catch {
      // No directory yet is an empty cache, not a failure: nothing has been
      // cached for this book and the panel has to say so rather than error.
      return [];
    }
    const chapters: CachedChapter[] = [];
    for (const name of names) {
      const info = await stat(join(dir, name)).catch(() => null);
      if (!info?.isFile()) continue;
      chapters.push({ index: Number.parseInt(name.slice(0, 4), 10) || 0, name, bytes: info.size });
    }
    return chapters.sort((left, right) => left.index - right.index);
  }

  /** Every cached chapter, for the zip export. */
  async files(userId: string, bookId: string): Promise<CachedChapterFile[]> {
    const dir = this.dir(userId, bookId);
    const result: CachedChapterFile[] = [];
    for (const chapter of await this.list(userId, bookId)) {
      const data = await readFile(join(dir, chapter.name)).catch(() => null);
      if (data) result.push({ name: chapter.name, data });
    }
    return result;
  }

  async clear(userId: string, bookId: string): Promise<number> {
    const removed = (await this.list(userId, bookId)).length;
    await rm(this.dir(userId, bookId), { recursive: true, force: true });
    return removed;
  }
}

/** `0007 第七章 归途.txt` — position first, so a plain file listing sorts. */
function fileName(index: number, title: string): string {
  return `${String(Math.max(1, index)).padStart(4, '0')} ${safeTitle(title)}.txt`;
}

/**
 * A title that is safe as a file name on every platform the reader might open
 * the archive on, and short enough to stay under the common 255-byte limit.
 */
function safeTitle(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .replace(/[. ]+$/, '');
  return cleaned || '未命名';
}

/** One path segment that cannot traverse: ids are hex or uuid, and never dots. */
function segment(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) return 'invalid';
  return value;
}
