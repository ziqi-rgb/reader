import { randomUUID } from 'node:crypto';
import { badRequest, notFound } from '../lib/errors.ts';
import type { Db } from '../db/index.ts';

export interface BookGroup {
  id: string;
  name: string;
  /** How many books this account put in the group. */
  bookCount: number;
}

/** A group as it appears on a book: the name is what the card draws. */
export interface BookGroupRef {
  id: string;
  name: string;
}

const MAX_NAME = 60;

/**
 * This account's groups for a batch of books, in one query.
 *
 * Free function rather than a method so `ShelfService` can fill `BookDto.groups`
 * without depending on the service object (and without an import cycle).
 */
export function groupsOfBooks(db: Db, userId: string, bookIds: readonly string[]): Map<string, BookGroupRef[]> {
  const ids = [...new Set(bookIds)];
  const byBook = new Map<string, BookGroupRef[]>();
  if (ids.length === 0) return byBook;
  const rows = db.all<{ book_id: string; id: string; name: string }>(
    `SELECT m.book_id, g.id, g.name FROM book_group_members m
     JOIN book_groups g ON g.id = m.group_id
     WHERE g.user_id = ? AND m.book_id IN (${ids.map(() => '?').join(',')})
     ORDER BY g.name COLLATE NOCASE ASC`,
    userId, ...ids,
  );
  for (const row of rows) {
    const list = byBook.get(row.book_id) ?? [];
    list.push({ id: row.id, name: row.name });
    byBook.set(row.book_id, list);
  }
  return byBook;
}

function cleanName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!name) throw badRequest('分组名称不能为空', 'GROUP_NAME_REQUIRED');
  if (name.length > MAX_NAME) throw badRequest(`分组名称最多 ${MAX_NAME} 个字符`, 'GROUP_NAME_TOO_LONG');
  return name;
}

/**
 * Reader-owned groupings.
 *
 * Deliberately *not* built on `series` or `tags`: those come from the file and the
 * scanner rewrites them on every pass, so a shelf structure the reader maintains
 * by hand cannot live there. A group is per-account (`user_id`) and many-to-many —
 * one book may sit in several groups, which is what makes 「或 / 与 / 非」 filtering
 * meaningful.
 */
export class GroupService {
  constructor(private readonly db: Db) {}

  list(userId: string): BookGroup[] {
    const rows = this.db.all<{ id: string; name: string; n: number }>(
      `SELECT g.id, g.name,
              (SELECT COUNT(*) FROM book_group_members m
                JOIN user_books ub ON ub.book_id = m.book_id AND ub.user_id = g.user_id AND ub.hidden = 0
                WHERE m.group_id = g.id) AS n
       FROM book_groups g
       WHERE g.user_id = ?
       ORDER BY g.name COLLATE NOCASE ASC`,
      userId,
    );
    return rows.map((row) => ({ id: row.id, name: row.name, bookCount: row.n }));
  }

  create(userId: string, name: unknown): BookGroup {
    const clean = cleanName(name);
    const id = randomUUID();
    const now = Date.now();
    try {
      this.db.run(
        'INSERT INTO book_groups (id, user_id, name, created_at, updated_at) VALUES (?,?,?,?,?)',
        id, userId, clean, now, now,
      );
    } catch (error) {
      // The unique index is (user_id, name COLLATE NOCASE): two groups called
      // "科幻" and "科幻 " would otherwise both exist and neither would be findable.
      if (/UNIQUE/i.test(String((error as Error)?.message ?? ''))) {
        throw badRequest('已存在同名分组', 'GROUP_NAME_TAKEN');
      }
      throw error;
    }
    return { id, name: clean, bookCount: 0 };
  }

  rename(userId: string, id: string, name: unknown): BookGroup {
    const clean = cleanName(name);
    this.require(userId, id);
    try {
      this.db.run('UPDATE book_groups SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?', clean, Date.now(), id, userId);
    } catch (error) {
      if (/UNIQUE/i.test(String((error as Error)?.message ?? ''))) {
        throw badRequest('已存在同名分组', 'GROUP_NAME_TAKEN');
      }
      throw error;
    }
    const count = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM book_group_members WHERE group_id = ?', id);
    return { id, name: clean, bookCount: count?.n ?? 0 };
  }

  /** Deleting a group drops its memberships only; the books stay on the shelf. */
  remove(userId: string, id: string): void {
    this.require(userId, id);
    this.db.run('DELETE FROM book_groups WHERE id = ? AND user_id = ?', id, userId);
  }

  require(userId: string, id: string): { id: string; name: string } {
    const row = this.db.get<{ id: string; name: string }>(
      'SELECT id, name FROM book_groups WHERE id = ? AND user_id = ?', id, userId,
    );
    if (!row) throw notFound('分组不存在', 'GROUP_NOT_FOUND');
    return row;
  }

  /** This account's groups for one book. */
  idsOf(userId: string, bookId: string): string[] {
    const rows = this.db.all<{ id: string }>(
      `SELECT g.id FROM book_group_members m JOIN book_groups g ON g.id = m.group_id
       WHERE m.book_id = ? AND g.user_id = ? ORDER BY g.name COLLATE NOCASE ASC`,
      bookId, userId,
    );
    return rows.map((row) => row.id);
  }

  groupsOf(userId: string, bookIds: readonly string[]): Map<string, BookGroupRef[]> {
    return groupsOfBooks(this.db, userId, bookIds);
  }

  /**
   * Replaces one book's memberships for this account.
   *
   * Only this account's groups are touched, so two readers can file the same book
   * differently without stepping on each other (memberships are rows, not a column).
   */
  setForBook(userId: string, bookId: string, groupIds: readonly unknown[]): string[] {
    const ids = [...new Set(groupIds.map((value) => String(value)).filter(Boolean))];
    if (ids.length > 0) {
      const owned = this.db.all<{ id: string }>(
        `SELECT id FROM book_groups WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
        userId, ...ids,
      );
      if (owned.length !== ids.length) throw badRequest('分组不存在', 'GROUP_NOT_FOUND');
    }
    const now = Date.now();
    this.db.transaction(() => {
      this.db.run(
        `DELETE FROM book_group_members
          WHERE book_id = ? AND group_id IN (SELECT id FROM book_groups WHERE user_id = ?)`,
        bookId, userId,
      );
      for (const id of ids) {
        this.db.run('INSERT INTO book_group_members (group_id, book_id, added_at) VALUES (?,?,?)', id, bookId, now);
      }
    });
    return this.idsOf(userId, bookId);
  }
}
