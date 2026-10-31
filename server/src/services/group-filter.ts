import type { Db } from '../db/index.ts';
import { badRequest } from '../lib/errors.ts';
import { folderGroupDir } from './folder-groups.ts';
import { expandGroupIds, groupLevelOf, MAX_GROUP_LEVEL, UNFILED_GROUP_ID } from './groups.ts';

/** The three questions a reader asks of a level of groups: these, all of them, not these. */
export type GroupMode = 'or' | 'and' | 'not';

/**
 * A group filter, exactly as the shelf spells it.
 *
 * `groups` holds one entry per selected chip; a chip may stand for several ids
 * joined by `+` (a manual group and the folder group of the same name).
 */
export interface GroupFilterOptions {
  groups?: string[];
  /** One 或 / 与 / 非 per level (二级, 三级, 四级); the levels are AND-ed. */
  groupModes?: Partial<Record<2 | 3 | 4, GroupMode>>;
  /** The one-mode form older clients send; used for every level without its own. */
  groupMode?: GroupMode;
}

/** A validated 或 / 与 / 非, or a refusal naming the value. */
export function parseGroupMode(value: string | undefined): GroupMode | undefined {
  if (value === undefined) return undefined;
  if (value === 'or' || value === 'and' || value === 'not') return value;
  throw badRequest(`invalid group mode: ${value}`);
}

/** The `groups` / `groupMode2` / `groupMode3` / `groupMode4` query of a request. */
export function groupFilterFromQuery(query: Record<string, string | undefined>): GroupFilterOptions {
  const filter: GroupFilterOptions = {};
  if (query.groups !== undefined) {
    filter.groups = query.groups.split(',').map((value) => value.trim()).filter(Boolean);
  }
  const legacy = parseGroupMode(query.groupMode);
  if (legacy) filter.groupMode = legacy;
  const modes: Partial<Record<2 | 3 | 4, GroupMode>> = {};
  for (const level of [2, 3, 4] as const) {
    const mode = parseGroupMode(query[`groupMode${level}`]);
    if (mode) modes[level] = mode;
  }
  if (Object.keys(modes).length > 0) filter.groupModes = modes;
  return filter;
}

/**
 * Escapes the two characters `LIKE` treats specially.
 *
 * `%` and `_` are legal in a filename and both are wildcards; a folder called
 * `100%` would otherwise match `1000 books` as well. The escape character itself
 * has to be escaped first, or escaping `%` would produce `\\%` which then means a
 * literal backslash followed by any run.
 */
export function escapeLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * One chip, as a SQL predicate.
 *
 * `value` is one entry of a `groups` filter. It names a manual group (`id`), a
 * folder group (`folder:dir`), 「未分组」 (`unfiled`), or several of those joined
 * by `+` — which is how a merged chip comes back: 「R18」 filed by hand and the
 * 「R18」 folder are one section, so their parts are OR-ed inside the condition and
 * 与 / 非 still count the chip once.
 *
 * `bookId` is the SQL expression naming the book row (`b.id` in a list query,
 * `ub.book_id` when counting) — never user input.
 */
export function groupCondition(
  userId: string,
  owned: ReadonlyArray<{ id: string; name: string }>,
  value: string,
  bookId: string,
): { sql: string; params: Array<string | number>; level: number } | null {
  const parts = value.split('+').map((part) => part.trim()).filter(Boolean);
  const sqls: string[] = [];
  const params: Array<string | number> = [];
  /** The level of the first part that names a real group; 未分组 counts as 1. */
  let level = 0;
  for (const part of parts) {
    if (part === UNFILED_GROUP_ID) {
      // Both halves of "grouped": no manual group *and* no folder group. The two
      // tests have to match `GroupService.unfiled()`'s count exactly — a chip that
      // says 12 and opens 3 is the bug this predicate exists to prevent.
      sqls.push(`(NOT EXISTS (SELECT 1 FROM book_group_members gm JOIN book_groups g ON g.id = gm.group_id
                             WHERE gm.book_id = ${bookId} AND g.user_id = ?)
                 AND NOT EXISTS (SELECT 1 FROM book_files f
                                 WHERE f.book_id = ${bookId} AND f.missing = 0
                                   AND instr(f.rel_path, '/') > 0))`);
      params.push(userId);
      level = level || 1;
      continue;
    }
    const dir = folderGroupDir(part);
    if (dir) {
      sqls.push(`EXISTS (SELECT 1 FROM book_files f
                          WHERE f.book_id = ${bookId} AND f.missing = 0 AND f.rel_path LIKE ? ESCAPE '\\')`);
      params.push(`${escapeLike(dir)}/%`);
      level = level || dir.split('/').length;
      continue;
    }
    const row = owned.find((entry) => entry.id === part);
    level = level || (row ? groupLevelOf(row.name) : 1);
    const ids = [...new Set(expandGroupIds(owned, [part]))];
    sqls.push(`EXISTS (SELECT 1 FROM book_group_members gm JOIN book_groups g ON g.id = gm.group_id
                        WHERE gm.book_id = ${bookId} AND g.user_id = ? AND g.id IN (${ids.map(() => '?').join(',')}))`);
    params.push(userId, ...ids);
  }
  if (sqls.length === 0) return null;
  const sql = sqls.length > 1 ? `(${sqls.join(' OR ')})` : sqls[0];
  return sql ? { sql, params, level: level || 1 } : null;
}

/**
 * The WHERE fragments a group filter means, for any query over books.
 *
 * One entry of `options.groups` is one chip, and the chips are collected *per
 * level*: 篇幅, tag and tag 细分 are different dimensions, so each level gets its
 * own 或 / 与 / 非 and the levels are AND-ed together. A level with nothing
 * selected does not take part, and the top-level group (and 未分组) is always a
 * plain AND condition with no mode of its own.
 *
 * A `book_groups` id is expanded through this account's tree first: selecting
 * 「小说」 has to include 「小说.奇幻」, otherwise a reader who files books only
 * into the specific subgroup would find their section empty. A `folder:` id names
 * a folder, and matching `rel_path` by prefix already includes every deeper folder
 * — that is the same "and below".
 *
 * Shared by the shelf and by 追更 on purpose: a filter that means one thing on the
 * shelf and something slightly different in the follow list would be a bug the
 * reader has to discover twice.
 */
export function groupFilterConditions(
  db: Db,
  userId: string,
  options: GroupFilterOptions,
  /** SQL expression naming the book row: `b.id`, `ub.book_id`. Never user input. */
  bookId: string,
): { where: string[]; params: Array<string | number> } {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (!options.groups || options.groups.length === 0) return { where, params };
  const legacyMode = options.groupMode ?? 'or';
  if (legacyMode !== 'or' && legacyMode !== 'and' && legacyMode !== 'not') throw badRequest('invalid group mode');
  const owned = db.all<{ id: string; name: string }>(
    'SELECT id, name FROM book_groups WHERE user_id = ?', userId,
  );
  const byLevel = new Map<number, Array<{ sql: string; params: Array<string | number> }>>();
  for (const value of options.groups) {
    const condition = groupCondition(userId, owned, value, bookId);
    if (!condition) continue;
    const level = Math.min(condition.level, MAX_GROUP_LEVEL);
    const list = byLevel.get(level) ?? [];
    list.push(condition);
    byLevel.set(level, list);
  }
  const add = (conditions: ReadonlyArray<{ sql: string; params: Array<string | number> }>) => {
    for (const condition of conditions) {
      where.push(condition.sql);
      params.push(...condition.params);
    }
  };
  add(byLevel.get(1) ?? []);
  for (const level of [2, 3, 4] as const) {
    const conditions = byLevel.get(level) ?? [];
    if (conditions.length === 0) continue;
    const mode = options.groupModes?.[level] ?? legacyMode;
    if (mode !== 'or' && mode !== 'and' && mode !== 'not') throw badRequest('invalid group mode');
    if (mode === 'and') {
      add(conditions);
      continue;
    }
    const joined = conditions.map((condition) => condition.sql).join(' OR ');
    where.push(mode === 'not' ? `NOT (${joined})` : `(${joined})`);
    for (const condition of conditions) params.push(...condition.params);
  }
  if (byLevel.size === 0) {
    // Nothing in the filter can match (ids that no longer exist): say so with a
    // predicate instead of quietly widening to the whole shelf.
    where.push('0 = 1');
  }
  return { where, params };
}
