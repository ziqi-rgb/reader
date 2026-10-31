import { FOLDER_GROUP_PREFIX, GROUP_PATH_SEPARATOR, type BookGroupRef } from './groups.ts';
import type { Db } from '../db/index.ts';

/**
 * Groups the reader never created: a book's folders *are* its groups.
 *
 * 「故事/长篇/喜剧/x.epub」 (relative to BOOKS_DIR) belongs to 「故事.长篇.喜剧」.
 * Nothing is stored — the folders are the source of truth, so moving a file or a
 * rescan changes the grouping with no migration and no per-account copy, and the
 * same 筛选 works on the shelf and in the library. That is also why these groups
 * cannot be renamed or deleted: they describe the filesystem, not the reader.
 *
 * Only the first three folder levels below the library root become a name (the
 * reader's own groups go one level deeper, but a directory tree that deep is not a
 * classification), and a book is filed at the deepest of them; the ancestors exist
 * as sections, and selecting one already includes everything below it.
 */
export const MAX_FOLDER_LEVEL = 3;
export { FOLDER_GROUP_PREFIX };

/**
 * A folder name may itself contain dots (「Vol.1」, 「2019.10」), and the dot is the
 * level separator — so the separator is re-spelled inside a name rather than
 * letting such a folder pretend to be two levels.
 */
const DOT_IN_FOLDER_NAME = '\u00B7';

export interface FolderGroupSeed {
  id: string;
  name: string;
  level: number;
  parentId: string | null;
  /** Books sitting *directly* in this folder. */
  bookCount: number;
  /** Books in this folder and every folder below it, de-duplicated. */
  subtreeCount: number;
}

export function folderGroupId(dir: string): string {
  return FOLDER_GROUP_PREFIX + dir;
}

/** Is this id a folder group (rather than a row id from `book_groups`)? */
export function isFolderGroupId(id: string): boolean {
  return id.startsWith(FOLDER_GROUP_PREFIX);
}

/** `folder:故事/长篇` → `故事/长篇`; anything else → `null`. */
export function folderGroupDir(id: string): string | null {
  return isFolderGroupId(id) ? id.slice(FOLDER_GROUP_PREFIX.length) : null;
}

/** The folders a library-relative path sits in, at most 3 deep. */
export function folderSegmentsOf(relPath: string): string[] {
  return relPath
    .split('/')
    .slice(0, -1)
    .filter((segment) => segment !== '' && segment !== '.')
    .slice(0, MAX_FOLDER_LEVEL);
}

function folderGroupName(segments: readonly string[]): string {
  return segments
    .map((segment) => segment.split(GROUP_PATH_SEPARATOR).join(DOT_IN_FOLDER_NAME))
    .join(GROUP_PATH_SEPARATOR);
}

/** 「.」 joined path of a file's folders, e.g. 「故事.长篇.喜剧」; `null` at the root. */
export function folderGroupPathOf(relPath: string): string | null {
  const segments = folderSegmentsOf(relPath);
  return segments.length > 0 ? folderGroupName(segments) : null;
}

/** The one group a file is filed into by its folders, or `null` at the root. */
export function folderGroupOf(relPath: string): { id: string; name: string } | null {
  const segments = folderSegmentsOf(relPath);
  if (segments.length === 0) return null;
  return { id: folderGroupId(segments.join('/')), name: folderGroupName(segments) };
}

/**
 * Every folder group in the library, with the counts the shelf draws.
 *
 * Read once per request rather than stored: the tree is whatever the files are,
 * and a table would only be a copy that can disagree with them.
 *
 * With a `userId` the counts follow that reader's shelf (`hidden = 0`), which is
 * what the shelf's own chips mean: a folder with 100 books in the library but 3 on
 * this reader's shelf has to say 3, or the number under the chip contradicts the
 * grid it filters.
 */
export function folderGroups(db: Db, userId?: string): FolderGroupSeed[] {
  const files = userId
    ? db.all<{ book_id: string; rel_path: string }>(
      `SELECT f.book_id, f.rel_path FROM book_files f
        JOIN user_books ub ON ub.book_id = f.book_id AND ub.user_id = ? AND ub.hidden = 0
       WHERE f.missing = 0`,
      userId,
    )
    : db.all<{ book_id: string; rel_path: string }>(
      'SELECT book_id, rel_path FROM book_files WHERE missing = 0',
    );
  interface Entry {
    id: string;
    name: string;
    level: number;
    parentId: string | null;
    books: Set<string>;
  }
  const entries = new Map<string, Entry>();
  for (const file of files) {
    const segments = folderSegmentsOf(file.rel_path);
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const dirs = segments.slice(0, depth);
      const id = folderGroupId(dirs.join('/'));
      let entry = entries.get(id);
      if (!entry) {
        entry = {
          id,
          name: folderGroupName(dirs),
          level: depth,
          parentId: depth > 1 ? folderGroupId(dirs.slice(0, -1).join('/')) : null,
          books: new Set<string>(),
        };
        entries.set(id, entry);
      }
      // Only the deepest folder holds the book: its ancestors are sections of it.
      if (depth === segments.length) entry.books.add(file.book_id);
    }
  }
  if (entries.size === 0) return [];
  /*
   * Subtree counts up the name chain instead of scanning every pair: an account
   * may have thousands of folders and the shelf draws one count per chip.
   */
  const byName = new Map<string, Entry>();
  for (const entry of entries.values()) byName.set(entry.name, entry);
  const subtree = new Map<string, Set<string>>();
  for (const entry of entries.values()) {
    const segments = entry.name.split(GROUP_PATH_SEPARATOR);
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const ancestor = byName.get(segments.slice(0, depth).join(GROUP_PATH_SEPARATOR));
      if (!ancestor) continue;
      const books = subtree.get(ancestor.id) ?? new Set<string>();
      for (const bookId of entry.books) books.add(bookId);
      subtree.set(ancestor.id, books);
    }
  }
  return [...entries.values()].map((entry) => ({
    id: entry.id,
    name: entry.name,
    level: entry.level,
    parentId: entry.parentId,
    bookCount: entry.books.size,
    subtreeCount: subtree.get(entry.id)?.size ?? entry.books.size,
  }));
}

/**
 * The folder groups each book sits in, for a batch of books.
 *
 * A book may have several files (a comic split into volumes, a re-acquired copy),
 * so it may appear under several folders — the same answer the shelf's own list
 * gives, which is what keeps a card and 书籍详情 from disagreeing.
 */
export function folderGroupsOfBooks(db: Db, bookIds: readonly string[]): Map<string, BookGroupRef[]> {
  const ids = [...new Set(bookIds)];
  const byBook = new Map<string, BookGroupRef[]>();
  if (ids.length === 0) return byBook;
  const files = db.all<{ book_id: string; rel_path: string }>(
    `SELECT book_id, rel_path FROM book_files
      WHERE missing = 0 AND book_id IN (${ids.map(() => '?').join(',')})`,
    ...ids,
  );
  const seen = new Set<string>();
  for (const file of files) {
    const group = folderGroupOf(file.rel_path);
    if (!group) continue;
    const key = `${file.book_id}\u0000${group.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = byBook.get(file.book_id) ?? [];
    list.push({ id: group.id, name: group.name, kind: 'folder' });
    byBook.set(file.book_id, list);
  }
  for (const list of byBook.values()) {
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  return byBook;
}
