import type { Db } from '../db/index.ts';
import type { ChapterPublications } from '../publications/chapters.ts';
import { AppError, badRequest } from '../lib/errors.ts';
import type { Manifest } from '../indexer/formats/registry.ts';
import { groupsOfBooks, type BookGroupRef } from './groups.ts';
import { groupFilterConditions, type GroupFilterOptions } from './group-filter.ts';

/**
 * 连载状态 as the reader marks it by hand.
 *
 * Deliberately not inferred: a source's directory does not say whether a book is
 * finished, and a book that simply stopped updating is indistinguishable from one
 * whose author is on a break. Only the reader knows, so 追更 stores their answer.
 */
export const SERIAL_STATUSES = ['ongoing', 'completed'] as const;
export type SerialStatus = (typeof SERIAL_STATUSES)[number];

/** 追更 list filters: `unfinished` is 连载中 plus 还没有标记, i.e. "hide what is done". */
export const SERIAL_FILTERS = ['ongoing', 'completed', 'unfinished'] as const;
export type SerialFilter = (typeof SERIAL_FILTERS)[number];

export interface ChapterUpdateFilter extends GroupFilterOptions {
  /** Which 连载状态 to show; absent means every book. */
  serial?: SerialFilter;
}

interface Subscription {
  bookId: string; userId: string; enabled: number; intervalMinutes: number;
  serialStatus: SerialStatus | null;
  nextCheckAt: number; lastCheckAt: number | null; lastSuccessAt: number | null;
  lastError: string | null; failures: number; newChapters: number; generation: number;
}

/** One followed book as the 追更 list draws it. */
export interface ChapterUpdateView {
  bookId: string; title: string; enabled: boolean; intervalMinutes: number;
  /** `null` = 还没有标记. */
  serialStatus: SerialStatus | null;
  nextCheckAt: number; lastCheckAt: number | null; lastSuccessAt: number | null;
  lastError: string | null; newChapters: number;
  /** The reader's own groups this book sits in, so the row can say where it is filed. */
  groups: BookGroupRef[];
}
const FIELDS = `p.book_id AS bookId, p.user_id AS userId, COALESCE(s.enabled,0) AS enabled,
  COALESCE(s.interval_minutes,60) AS intervalMinutes, s.serial_status AS serialStatus, COALESCE(s.next_check_at,0) AS nextCheckAt,
  s.last_check_at AS lastCheckAt, s.last_success_at AS lastSuccessAt, s.last_error AS lastError,
  COALESCE(s.failures,0) AS failures, COALESCE(s.new_chapters,0) AS newChapters, COALESCE(s.generation,0) AS generation`;

/** Durable opt-in subscriptions. One bounded sequential worker shares SourceHost's call budget. */
export class ChapterUpdates {
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private controller = new AbortController();
  private readonly checks = new Map<string, Promise<Manifest>>();
  constructor(private readonly db: Db, private readonly chapters: ChapterPublications, private readonly now = Date.now) {}

  /**
   * The reader's followed books, narrowed the way the shelf is.
   *
   * `filter.groups` / `groupModes` are the shelf's own four-level selection (see
   * `group-filter.ts`), and `filter.serial` is the hand-made 连载状态. With a few
   * hundred followed books the list is unreadable without them, and the question
   * that matters — "what is still updating in 小说.奇幻" — is exactly these two.
   */
  list(userId: string, filter: ChapterUpdateFilter = {}): ChapterUpdateView[] {
    const where = ['p.user_id = ?'];
    const params: Array<string | number> = [userId];
    if (filter.groups && filter.groups.length > 0) {
      const groups = groupFilterConditions(this.db, userId, filter, 'b.id');
      where.push(...groups.where);
      params.push(...groups.params);
    }
    if (filter.serial === 'ongoing') where.push(`s.serial_status = 'ongoing'`);
    else if (filter.serial === 'completed') where.push(`s.serial_status = 'completed'`);
    else if (filter.serial === 'unfinished') where.push(`COALESCE(s.serial_status, '') <> 'completed'`);
    const rows = this.db.all<Subscription & { title: string }>(`SELECT ${FIELDS}, b.title FROM chapter_publications p
      JOIN books b ON b.id = p.book_id JOIN user_books u ON u.book_id = p.book_id AND u.user_id = p.user_id AND u.hidden = 0
      LEFT JOIN chapter_subscriptions s ON s.book_id = p.book_id WHERE ${where.join(' AND ')} ORDER BY b.title`, ...params)
      .map(({ userId: _user, generation: _generation, ...row }) => ({ ...row, enabled: row.enabled === 1 }));
    // One query for the whole page rather than one per row: the 分组 labels and the
    // filter chips have to name the same groups, and asking per book would be a
    // query storm behind a single panel.
    const byBook = groupsOfBooks(this.db, userId, rows.map((row) => row.bookId));
    return rows.map((row) => ({ ...row, groups: byBook.get(row.bookId) ?? [] }));
  }

  configure(userId: string, bookId: string, input: { enabled?: unknown; intervalMinutes?: unknown; acknowledge?: unknown; serialStatus?: unknown }) {
    this.chapters.manifest(userId, bookId);
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw badRequest('enabled must be boolean');
    if (input.acknowledge !== undefined && typeof input.acknowledge !== 'boolean') throw badRequest('acknowledge must be boolean');
    if (input.serialStatus !== undefined && input.serialStatus !== null
      && !SERIAL_STATUSES.includes(input.serialStatus as SerialStatus)) {
      throw badRequest(`serialStatus must be one of ${SERIAL_STATUSES.join(', ')} or null`);
    }
    if (input.intervalMinutes !== undefined && (!Number.isSafeInteger(input.intervalMinutes) || Number(input.intervalMinutes) < 15 || Number(input.intervalMinutes) > 10080)) {
      throw badRequest('intervalMinutes must be an integer between 15 and 10080');
    }
    this.db.transaction(() => {
      this.db.run('INSERT OR IGNORE INTO chapter_subscriptions (book_id) VALUES (?)', bookId);
      if (input.enabled !== undefined || input.intervalMinutes !== undefined) {
        this.db.run(`UPDATE chapter_subscriptions SET enabled = COALESCE(?,enabled), interval_minutes = COALESCE(?,interval_minutes),
          next_check_at = ?, failures = 0, last_error = NULL, generation = generation + 1 WHERE book_id = ?`,
        input.enabled === undefined ? null : Number(input.enabled), input.intervalMinutes === undefined ? null : Number(input.intervalMinutes), this.now(), bookId);
      }
      // 连载状态 is the reader's own note, not a schedule change: it must not
      // restart the check (and must not clear the failure count of a failing book).
      if (input.serialStatus !== undefined) {
        this.db.run('UPDATE chapter_subscriptions SET serial_status = ? WHERE book_id = ?',
          (input.serialStatus as SerialStatus | null), bookId);
      }
      if (input.acknowledge === true) this.db.run('UPDATE chapter_subscriptions SET new_chapters = 0 WHERE book_id = ?', bookId);
    });
    return this.list(userId).find((row) => row.bookId === bookId);
  }

  start(): void {
    if (this.timer) return;
    this.controller = new AbortController();
    this.timer = setInterval(() => { void this.runDue().catch(() => undefined); }, 60_000);
    this.timer.unref();
    void this.runDue().catch(() => undefined);
  }

  async stop(): Promise<void> {
    clearInterval(this.timer); this.timer = undefined;
    this.controller.abort();
    await this.active;
  }

  runDue(): Promise<void> {
    if (this.active) return this.active;
    this.active = this.run().finally(() => { this.active = undefined; });
    return this.active;
  }

  check(userId: string, bookId: string, signal?: AbortSignal): Promise<Manifest> {
    this.chapters.manifest(userId, bookId);
    const pending = this.checks.get(bookId);
    if (pending) return pending;
    const action = this.performCheck(userId, bookId, signal);
    this.checks.set(bookId, action);
    void action.finally(() => { if (this.checks.get(bookId) === action) this.checks.delete(bookId); }).catch(() => undefined);
    return action;
  }

  private async performCheck(userId: string, bookId: string, signal?: AbortSignal): Promise<Manifest> {
    this.db.run('INSERT OR IGNORE INTO chapter_subscriptions (book_id) VALUES (?)', bookId);
    const item = this.db.get<Subscription>(`SELECT ${FIELDS} FROM chapter_publications p
      JOIN chapter_subscriptions s ON s.book_id = p.book_id WHERE p.book_id = ?`, bookId)!;
    this.db.run('UPDATE chapter_subscriptions SET next_check_at = ?, last_check_at = ? WHERE book_id = ?', this.now() + 300_000, this.now(), bookId);
    try {
      const old = new Set(this.chapters.manifest(userId, bookId).items.map((entry) => entry.href));
      const fresh = await this.chapters.refresh(userId, bookId, signal);
      const added = fresh.items.filter((entry) => !old.has(entry.href)).length;
      this.db.run(`UPDATE chapter_subscriptions SET last_success_at = ?, next_check_at = ?, last_error = NULL,
        failures = 0, new_chapters = new_chapters + ? WHERE book_id = ? AND generation = ?`,
      this.now(), this.now() + item.intervalMinutes * 60_000, added, bookId, item.generation);
      return fresh;
    } catch (error) {
      const delay = Math.min(10080, Math.max(item.intervalMinutes, Math.min(1440, 15 * 2 ** Math.min(item.failures, 7))));
      const code = error instanceof AppError && /^[A-Z_]{1,80}$/.test(error.code) ? error.code : 'UPDATE_FAILED';
      this.db.run('UPDATE chapter_subscriptions SET next_check_at = ?, last_error = ?, failures = failures + 1 WHERE book_id = ? AND generation = ?',
        this.now() + delay * 60_000, code, bookId, item.generation);
      throw error;
    }
  }

  private async run(): Promise<void> {
    const due = this.db.all<Subscription>(`SELECT ${FIELDS} FROM chapter_publications p
      JOIN chapter_subscriptions s ON s.book_id = p.book_id
      JOIN source_instances i ON i.id = p.source_id AND i.enabled = 1
      JOIN users a ON a.id = p.user_id AND a.disabled = 0
      JOIN user_books u ON u.book_id = p.book_id AND u.user_id = p.user_id AND u.hidden = 0
      WHERE s.enabled = 1 AND s.next_check_at <= ? ORDER BY s.next_check_at LIMIT 20`, this.now());
    for (const item of due) {
      if (this.controller.signal.aborted) return;
      const eligible = this.db.get('SELECT book_id FROM chapter_subscriptions WHERE book_id = ? AND enabled = 1 AND generation = ? AND next_check_at <= ?', item.bookId, item.generation, this.now());
      if (!eligible) continue;
      try {
        await this.check(item.userId, item.bookId, this.controller.signal);
      } catch {
        if (this.controller.signal.aborted) return;
        // Failure is recorded per book; other subscriptions still get a turn.
      }
    }
  }
}
