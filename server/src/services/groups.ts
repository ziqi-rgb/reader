import { randomUUID } from 'node:crypto';
import { badRequest, notFound } from '../lib/errors.ts';
import type { Db } from '../db/index.ts';
import { shelfScopeSql } from './shelf-scope.ts';

/**
 * One group of the reader's own shelf structure.
 *
 * A group is named by its whole path: 「小说.奇幻.剑与魔法」 is a third-level group
 * whose parent is 「小说.奇幻」. The dot is the only hierarchy the model has — no
 * `parent_id` column — because a group is just a name the reader types, and the
 * path stays readable in the URL (`?groups=<id>`), on a card and in an export.
 */
export const GROUP_PATH_SEPARATOR = '.';
/** The deepest a group may sit: 大类 → 篇幅 → tag → tag 细分. */
export const MAX_GROUP_LEVEL = 4;
/**
 * Stands in for a level that was skipped: a tag group created straight under a
 * 大类 is 「小说.-.奇幻」 — three segments, so the level is still readable from the
 * name, but 「-」 is never a group of its own and can never be typed as a name.
 */
export const GROUP_LEVEL_PLACEHOLDER = '-';
/**
 * Marks an id that names a folder group (derived from `book_files.rel_path`) rather
 * than a row in `book_groups`. Defined here, with the rest of the group model, so
 * the services that only need to recognise one do not import the derivation.
 */
export const FOLDER_GROUP_PREFIX = 'folder:';
/**
 * The pseudo-group that means "not filed anywhere".
 *
 * It has to exist as a selectable thing: once the shelf opens on a default group
 * (or any filter is applied), a book that was never filed would otherwise be
 * unreachable — there is no chip that means "nothing".
 *
 * A folder group counts as filing. A book under 「故事/长篇」 is already grouped —
 * the folder chip filters to it — so leaving it in 未分组 as well put the same book
 * in two places at once *and* made that chip's number disagree with its own filter
 * (it counted the book, the filter did not show it). 未分组 is therefore "no manual
 * group and no folder group": the file sits at the library root and the reader has
 * not filed it by hand either.
 */
export const UNFILED_GROUP_ID = 'unfiled';
export const UNFILED_GROUP_NAME = '未分组';
const MAX_NAME = 60;

export interface BookGroup {
  id: string;
  /** The whole path, as the reader typed it: 「小说.奇幻」. */
  name: string;
  /** 1-based depth; a name has at most `MAX_GROUP_LEVEL` segments. */
  level: number;
  /** The group one level up (`null` at the top), so the client need not parse names. */
  parentId: string | null;
  /** Books filed *directly* into this group. */
  bookCount: number;
  /** Books in this group and everything below it, de-duplicated. */
  subtreeCount: number;
  /**
   * The same two counts in **slots**: a 丛书 counts once, a loose book once.
   *
   * The shelf draws one card per slot, so a chip showing the book count says 「55」
   * over a grid of six cards. Both numbers are sent, and the reader's 「丛书算一本」
   * setting picks which one is drawn — that keeps the choice instant instead of a
   * round trip, and it keeps one definition of "slot" (the same one
   * `ShelfService.list` pages by) instead of two that can drift.
   */
  slotCount?: number;
  subtreeSlotCount?: number;
  /** The group the shelf opens with when nothing else is filtered. At most one per account. */
  isDefault: boolean;
  /** `manual` for a stored group, `folder`/`unfiled` for the derived pseudo-groups. */
  kind?: 'manual' | 'folder' | 'unfiled';
  /**
   * Folder groups that carry the same name as this manual group, merged into it.
   *
   * The shelf joins those ids with `+` when it filters, so one chip stands for
   * both. Only ever set on a stored group (rename and delete still address a row).
   */
  folderIds?: string[];
}

/** A group as it appears on a book: the name is what the card draws. */
export interface BookGroupRef {
  id: string;
  name: string;
  /**
   * `folder` groups are derived from the file layout (see `folder-groups.ts`) and
   * are read-only; `unfiled` is the pseudo-group for "no groups at all". Anything
   * else is a group the reader created.
   */
  kind?: 'manual' | 'folder' | 'unfiled';
}

/** 「小说.奇幻」 → ['小说', '奇幻'] — the one place a path is split. */
export function groupSegments(name: string): string[] {
  return name.split(GROUP_PATH_SEPARATOR).map((segment) => segment.trim());
}

export function groupLevelOf(name: string): number {
  return groupSegments(name).length;
}

/** 「小说.奇幻.剑与魔法」 → 「小说.奇幻」; a top-level name has no parent. */
export function groupParentName(name: string): string | null {
  const segments = groupSegments(name);
  // 「小说.-.奇幻」 hangs off 「小说」: the placeholder is a level, not a group.
  let depth = segments.length - 1;
  while (depth > 0 && segments[depth - 1] === GROUP_LEVEL_PLACEHOLDER) depth -= 1;
  return depth > 0 ? segments.slice(0, depth).join(GROUP_PATH_SEPARATOR) : null;
}

/** Is `name` the group `root` or one of its descendants? */
export function isWithinGroup(name: string, root: string): boolean {
  return name === root || name.startsWith(root + GROUP_PATH_SEPARATOR);
}

/**
 * SQL for the key a *slot* is counted by: a 丛书 counts once, a loose book once.
 *
 * `ShelfService.list` draws one card per slot, so every number the shelf shows has
 * to be taken this way or the chip says 「55」 over a grid of six. The series a
 * group is keyed by is the *effective* one — `metadata_overrides` wins, exactly as
 * it does for the card's own title — because a 丛书 the reader renamed by hand is
 * still one 丛书.
 *
 * `bookAlias` names the `books` row in the caller's query. Never user input.
 */
export function groupSlotKeySql(bookAlias: string): string {
  return `COALESCE(NULLIF(COALESCE((SELECT o.value FROM metadata_overrides o
                                    WHERE o.book_id = ${bookAlias}.id AND o.field = 'series'), ${bookAlias}.series), '')
                 , 'book:' || ${bookAlias}.id)`;
}

/**
 * The groups a filter selection really means.
 *
 * Choosing 「小说」 asks for that section of the shelf, so every group below it
 * comes along: a book filed under 「小说.奇幻」 belongs there too. Unknown ids are
 * kept as they are rather than dropped — a filter for a group that no longer
 * exists must match nothing, not quietly widen to the whole shelf.
 */
export function expandGroupIds(
  groups: readonly { id: string; name: string }[],
  ids: readonly string[],
): string[] {
  const roots = groups.filter((group) => ids.includes(group.id));
  const expanded = new Set<string>();
  for (const group of groups) {
    if (roots.some((root) => isWithinGroup(group.name, root.name))) expanded.add(group.id);
  }
  return expanded.size > 0 ? [...expanded] : [...ids];
}

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
    list.push({ id: row.id, name: row.name, kind: 'manual' });
    byBook.set(row.book_id, list);
  }
  return byBook;
}

/** Which level may sit under which: 二级 under 一级, 三级 under 一级/二级, 四级 under 三级. */
export function canNest(parentLevel: number, level: number): boolean {
  if (parentLevel === 1) return level === 2 || level === 3;
  if (parentLevel === 2) return level === 3;
  if (parentLevel === 3) return level === 4;
  return false;
}

/** A validated group name: the canonical path plus the segments it is made of. */
interface CleanName {
  name: string;
  segments: string[];
}

function cleanName(value: unknown): CleanName {
  const raw = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!raw) throw badRequest('分组名称不能为空', 'GROUP_NAME_REQUIRED');
  const segments = raw.split(GROUP_PATH_SEPARATOR).map((segment) => segment.trim());
  if (segments.some((segment) => !segment)) {
    throw badRequest('每一级分组都要有名字，格式如「小说.奇幻」', 'GROUP_NAME_INVALID');
  }
  if (segments.some((segment) => segment === GROUP_LEVEL_PLACEHOLDER)) {
    throw badRequest(`「${GROUP_LEVEL_PLACEHOLDER}」是层级占位符，不能作为分组名`, 'GROUP_NAME_INVALID');
  }
  if (segments.length > MAX_GROUP_LEVEL) {
    throw badRequest(`分组最多 ${MAX_GROUP_LEVEL} 级`, 'GROUP_LEVEL_LIMIT');
  }
  const name = segments.join(GROUP_PATH_SEPARATOR);
  if (name.length > MAX_NAME) throw badRequest(`分组名称最多 ${MAX_NAME} 个字符`, 'GROUP_NAME_TOO_LONG');
  return { name, segments };
}

interface GroupRow {
  id: string;
  name: string;
  is_default: number;
}

/**
 * Reader-owned groupings.
 *
 * Deliberately *not* built on `series` or `tags`: those come from the file and the
 * scanner rewrites them on every pass, so a shelf structure the reader maintains
 * by hand cannot live there. A group is per-account (`user_id`) and many-to-many —
 * one book may sit in several groups, which is what makes 「或 / 与 / 非」 filtering
 * meaningful.
 *
 * A name with dots is a path. The parent has to exist before a child is created,
 * so 「小说.奇幻」 without 「小说」 is refused rather than silently creating a
 * half-tree the reader never asked for; renaming or deleting a group carries its
 * descendants along, because their names are built on its own.
 */
export class GroupService {
  constructor(private readonly db: Db) {
    this.ensureAncestors();
  }

  /**
   * Fills in parents that a name implies but that were never created.
   *
   * Dots only became level separators in one release: a group called 「web.安全」
   * from an older build has no 「web」 row, and a group whose parent is missing is
   * unreachable from the shelf's top-level buttons (it is not a first-level group,
   * and the sheet only offers the two levels under one). Creating the missing
   * ancestor as an empty group keeps every existing name — nothing is rewritten —
   * and makes the tree whole. Runs on the service's first use, over every account.
   */
  private ensureAncestors(): void {
    const rows = this.db.all<{ user_id: string; name: string }>(
      'SELECT user_id, name FROM book_groups',
    );
    if (rows.length === 0) return;
    const owned = new Map<string, Set<string>>();
    for (const row of rows) {
      const names = owned.get(row.user_id) ?? new Set<string>();
      names.add(row.name.toLowerCase());
      owned.set(row.user_id, names);
    }
    const now = Date.now();
    const missing: Array<{ userId: string; name: string }> = [];
    for (const row of rows) {
      const names = owned.get(row.user_id)!;
      // Walk up the parent chain, skipping placeholders: 「小说.-.奇幻」 needs
      // 「小说」, never a group called 「-」.
      const chain: string[] = [];
      let parent = groupParentName(row.name);
      while (parent) {
        chain.unshift(parent);
        parent = groupParentName(parent);
      }
      for (const name of chain) {
        if (names.has(name.toLowerCase())) continue;
        names.add(name.toLowerCase());
        missing.push({ userId: row.user_id, name });
      }
    }
    if (missing.length === 0) return;
    this.db.transaction(() => {
      for (const group of missing) {
        this.db.run(
          'INSERT INTO book_groups (id, user_id, name, created_at, updated_at) VALUES (?,?,?,?,?)',
          randomUUID(), group.userId, group.name, now, now,
        );
      }
    });
  }

  list(userId: string): BookGroup[] {
    const rows = this.db.all<{ id: string; name: string; is_default: number; n: number; slots: number }>(
      `SELECT g.id, g.name, g.is_default,
              (SELECT COUNT(*) FROM book_group_members m
                JOIN user_books ub ON ub.book_id = m.book_id AND ub.user_id = g.user_id AND ub.hidden = 0
                WHERE m.group_id = g.id AND ${shelfScopeSql('ub.book_id')}) AS n,
              (SELECT COUNT(DISTINCT ${groupSlotKeySql('b')}) FROM book_group_members m
                JOIN user_books ub ON ub.book_id = m.book_id AND ub.user_id = g.user_id AND ub.hidden = 0
                JOIN books b ON b.id = m.book_id
                WHERE m.group_id = g.id AND ${shelfScopeSql('ub.book_id')}) AS slots
       FROM book_groups g
       WHERE g.user_id = ?
       ORDER BY g.name COLLATE NOCASE ASC`,
      userId,
    );
    if (rows.length === 0) return [];
    /*
     * Subtree counts in one pass. A group can hold dozens of descendants and the
     * shelf shows a count per top-level chip, so the alternative — one COUNT per
     * group — would be a query storm behind a single panel. The membership rows of
     * one account are small (a book × the groups it sits in).
     */
    const members = this.db.all<{ group_id: string; book_id: string; slot_key: string }>(
      `SELECT m.group_id, m.book_id, ${groupSlotKeySql('b')} AS slot_key FROM book_group_members m
        JOIN book_groups g ON g.id = m.group_id
        JOIN user_books ub ON ub.book_id = m.book_id AND ub.user_id = g.user_id AND ub.hidden = 0
        JOIN books b ON b.id = m.book_id
       WHERE g.user_id = ? AND ${shelfScopeSql('ub.book_id')}`,
      userId,
    );
    const booksOf = new Map<string, Set<string>>();
    /** The same membership keyed by slot: a 丛书 contributes one key per group. */
    const slotsOf = new Map<string, Set<string>>();
    for (const row of members) {
      const books = booksOf.get(row.group_id) ?? new Set<string>();
      books.add(row.book_id);
      booksOf.set(row.group_id, books);
      const slots = slotsOf.get(row.group_id) ?? new Set<string>();
      slots.add(row.slot_key);
      slotsOf.set(row.group_id, slots);
    }
    const idByName = new Map(rows.map((row) => [row.name, row.id] as const));
    return rows.map((row) => {
      const subtree = new Set<string>();
      const subtreeSlots = new Set<string>();
      for (const other of rows) {
        if (!isWithinGroup(other.name, row.name)) continue;
        for (const bookId of booksOf.get(other.id) ?? []) subtree.add(bookId);
        for (const slotKey of slotsOf.get(other.id) ?? []) subtreeSlots.add(slotKey);
      }
      const parentName = groupParentName(row.name);
      return {
        id: row.id,
        name: row.name,
        level: groupLevelOf(row.name),
        parentId: parentName ? idByName.get(parentName) ?? null : null,
        bookCount: row.n,
        subtreeCount: subtree.size,
        slotCount: row.slots,
        subtreeSlotCount: subtreeSlots.size,
        isDefault: row.is_default === 1,
        kind: 'manual' as const,
      };
    });
  }

  /**
   * Creates a group.
   *
   * Two ways in, both ending at the same stored path:
   * - `parentId` + `level` — what the management page uses. The level comes from
   *   the picker, so a tag can be created straight under a 大类: the skipped level
   *   becomes the `-` placeholder in the name (「小说.-.奇幻」) and the tree keeps
   *   its shape.
   * - a plain name — 「小说.奇幻」 is parsed as a path, which is what the shelf's
   *   own "new top-level group" form sends (a single segment).
   */
  create(userId: string, name: unknown, options: { parentId?: string; level?: number } = {}): BookGroup {
    const clean = cleanName(name);
    const rows = this.rowsOf(userId);
    let canonical: string;
    if (options.parentId) {
      const parent = rows.find((row) => row.id === options.parentId);
      if (!parent) throw notFound('分组不存在', 'GROUP_NOT_FOUND');
      const parentLevel = groupLevelOf(parent.name);
      const level = options.level ?? parentLevel + 1;
      if (!Number.isInteger(level) || level < 2 || level > MAX_GROUP_LEVEL) {
        throw badRequest(`分组层级要在 2 到 ${MAX_GROUP_LEVEL} 之间`, 'GROUP_LEVEL_INVALID');
      }
      if (level - parentLevel < 1 || level - parentLevel > 2 || !canNest(parentLevel, level)) {
        throw badRequest(`「${parent.name}」下面不能建 ${level} 级分组`, 'GROUP_LEVEL_INVALID');
      }      const gaps = level - parentLevel - 1;
      canonical = [
        ...groupSegments(parent.name),
        ...Array.from({ length: gaps }, () => GROUP_LEVEL_PLACEHOLDER),
        clean.segments[clean.segments.length - 1],
      ].join(GROUP_PATH_SEPARATOR);
    } else {
      // A child is only allowed under a group that exists, and the stored name
      // borrows the parent's exact spelling so that every descendant shares one
      // prefix (the uniqueness index is NOCASE, prefix matching is not).
      const parent = clean.segments.length > 1 ? this.resolveParent(rows, clean.segments) : null;
      canonical = parent ? [parent.name, clean.segments[clean.segments.length - 1]].join(GROUP_PATH_SEPARATOR) : clean.name;
    }
    const id = randomUUID();
    const now = Date.now();
    try {
      this.db.run(
        'INSERT INTO book_groups (id, user_id, name, created_at, updated_at) VALUES (?,?,?,?,?)',
        id, userId, canonical, now, now,
      );
    } catch (error) {
      // The unique index is (user_id, name COLLATE NOCASE): two groups called
      // "科幻" and "科幻 " would otherwise both exist and neither would be findable.
      if (/UNIQUE/i.test(String((error as Error)?.message ?? ''))) {
        throw badRequest('已存在同名分组', 'GROUP_NAME_TAKEN');
      }
      throw error;
    }
    return this.byId(userId, id);
  }

  rename(userId: string, id: string, name: unknown): BookGroup {
    const clean = cleanName(name);
    const rows = this.rowsOf(userId);
    const current = rows.find((row) => row.id === id);
    if (!current) throw notFound('分组不存在', 'GROUP_NOT_FOUND');
    const parent = clean.segments.length > 1 ? this.resolveParent(rows, clean.segments) : null;
    const renamed = parent ? [parent.name, clean.segments[clean.segments.length - 1]].join(GROUP_PATH_SEPARATOR) : clean.name;
    if (parent && (parent.id === id || isWithinGroup(parent.name, current.name))) {
      throw badRequest('分组不能移到它自己下面', 'GROUP_PARENT_CYCLE');
    }
    // Its own name is the prefix of every descendant's, so they all move with it.
    const moves = rows
      .filter((row) => row.id === id || isWithinGroup(row.name, current.name))
      .map((row) => ({
        id: row.id,
        name: row.id === id ? renamed : renamed + row.name.slice(current.name.length),
      }));
    for (const move of moves) {
      if (groupLevelOf(move.name) > MAX_GROUP_LEVEL) {
        throw badRequest(`分组最多 ${MAX_GROUP_LEVEL} 级`, 'GROUP_LEVEL_LIMIT');
      }
    }
    const moving = new Set(moves.map((move) => move.id));
    const taken = new Set(rows.filter((row) => !moving.has(row.id)).map((row) => row.name.toLowerCase()));
    for (const move of moves) {
      if (taken.has(move.name.toLowerCase())) throw badRequest('已存在同名分组', 'GROUP_NAME_TAKEN');
    }
    const now = Date.now();
    this.db.transaction(() => {
      for (const move of moves) {
        this.db.run('UPDATE book_groups SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?', move.name, now, move.id, userId);
      }
    });
    return this.byId(userId, id);
  }

  /**
   * Deleting a group takes its descendants with it; the books stay on the shelf.
   *
   * A child cannot outlive its parent: its name starts with the parent's, so
   * leaving it behind would make a name whose path has a hole in it.
   */
  remove(userId: string, id: string): void {
    const rows = this.rowsOf(userId);
    const current = rows.find((row) => row.id === id);
    if (!current) throw notFound('分组不存在', 'GROUP_NOT_FOUND');
    const doomed = rows.filter((row) => row.id === id || isWithinGroup(row.name, current.name));
    this.db.transaction(() => {
      for (const row of doomed) {
        this.db.run('DELETE FROM book_groups WHERE id = ? AND user_id = ?', row.id, userId);
      }
    });
  }

  /** How many groups a delete would take with it (the sheet has to say so). */
  descendantCount(userId: string, id: string): number {
    const rows = this.rowsOf(userId);
    const current = rows.find((row) => row.id === id);
    if (!current) return 0;
    return rows.filter((row) => row.id !== id && isWithinGroup(row.name, current.name)).length;
  }

  /** Marks one group as the shelf's opening view, or clears the choice with `null`. */
  setDefault(userId: string, id: string | null): string | null {
    if (id === null) {
      this.db.run('UPDATE book_groups SET is_default = 0 WHERE user_id = ?', userId);
      return null;
    }
    this.require(userId, id);
    this.db.transaction(() => {
      this.db.run('UPDATE book_groups SET is_default = 0 WHERE user_id = ? AND is_default = 1', userId);
      this.db.run('UPDATE book_groups SET is_default = 1 WHERE id = ? AND user_id = ?', id, userId);
    });
    return id;
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

  /**
   * The 未分组 pseudo-group: the reader's shelf books that sit in none of their
   * groups *and* in none of the library's folders. Never stored.
   *
   * Both halves are required. The rows in `book_group_members` are what the reader
   * decided, the file's folder is what the shelf derived, and a book in either of
   * them is grouped — see `UNFILED_GROUP_ID`. The folder half has to be the same
   * test the filter uses (`group-filter.ts`), or the chip's count and the grid it
   * opens disagree.
   *
   * Always returned, even at zero: it is a filter, and a filter that comes and goes
   * with the data is a control that moves under the reader's finger.
   */
  unfiled(userId: string): BookGroup {
    const row = this.db.get<{ n: number; slots: number }>(
      `SELECT COUNT(*) AS n,
              COUNT(DISTINCT ${groupSlotKeySql('b')}) AS slots
         FROM user_books ub
         LEFT JOIN books b ON b.id = ub.book_id
        WHERE ub.user_id = ? AND ub.hidden = 0
          AND ${shelfScopeSql('ub.book_id')}
          AND NOT EXISTS (
            SELECT 1 FROM book_group_members m JOIN book_groups g ON g.id = m.group_id
             WHERE m.book_id = ub.book_id AND g.user_id = ub.user_id)
          AND NOT EXISTS (
            SELECT 1 FROM book_files f
             WHERE f.book_id = ub.book_id AND f.missing = 0
               AND instr(f.rel_path, '/') > 0)`,
      userId,
    );
    const count = row?.n ?? 0;
    const slots = row?.slots ?? 0;
    return {
      id: UNFILED_GROUP_ID,
      name: UNFILED_GROUP_NAME,
      level: 1,
      parentId: null,
      bookCount: count,
      subtreeCount: count,
      slotCount: slots,
      subtreeSlotCount: slots,
      isDefault: false,
      kind: 'unfiled',
    };
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
    // Folder groups and 未分组 are not rows: they describe the filesystem and the
    // absence of rows, so a write naming one is dropped rather than refused (the
    // client may have echoed back a book's whole group list).
    const ids = [...new Set(groupIds
      .map((value) => String(value))
      .filter((value) => value && value !== UNFILED_GROUP_ID && !value.startsWith(FOLDER_GROUP_PREFIX)))];
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

  private rowsOf(userId: string): GroupRow[] {
    return this.db.all<GroupRow>(
      'SELECT id, name, is_default FROM book_groups WHERE user_id = ? ORDER BY name COLLATE NOCASE ASC',
      userId,
    );
  }

  /** The parent named by a path's leading segments, or a refusal naming it. */
  private resolveParent(rows: readonly GroupRow[], segments: readonly string[]): GroupRow {
    const typed = segments.slice(0, -1).join(GROUP_PATH_SEPARATOR);
    const parent = rows.find((row) => row.name.toLowerCase() === typed.toLowerCase());
    if (!parent) throw badRequest(`请先创建上级分组「${typed}」`, 'GROUP_PARENT_MISSING');
    return parent;
  }

  private byId(userId: string, id: string): BookGroup {
    const group = this.list(userId).find((entry) => entry.id === id);
    if (!group) throw notFound('分组不存在', 'GROUP_NOT_FOUND');
    return group;
  }
}
