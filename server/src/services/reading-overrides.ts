import type { Db } from '../db/index.ts';
import { badRequest, conflict } from '../lib/errors.ts';

/**
 * A place the reader decided a new chapter starts.
 *
 * A heading-less TXT is read as one 正文 chapter (see `readingChapters` in
 * `indexer/formats/text.ts`), which is honest but leaves the reader with no way
 * to navigate a long story. This is the reader's own answer: they selected a
 * passage, so *that* is where the next chapter begins.
 *
 * Location is not a number. A chapter split changes every section's text offsets
 * and even its id, so an offset captured before the split would point into a
 * different paragraph afterwards — and a split mark that moved would silently
 * cut a story in the wrong place. `quote` plus its surrounding context is
 * matched against the file's own characters each time the book is opened, which
 * survives re-splitting, encoding choices and a different client.
 */
export interface ChapterMark { id: string; title: string; quote: string; prefix: string; suffix: string }

export interface ReadingOverrides { version: number; corrections: Array<{ id: string; anchor: { sectionId: string; start: number; end: number; quote: string; prefix: string; suffix: string }; replacement: string }>; headingPrefix: string; chapterMarks: ChapterMark[] }
const empty = (): ReadingOverrides => ({ version: 0, corrections: [], headingPrefix: '', chapterMarks: [] });

/**
 * A stored payload predates any field added since.
 *
 * Overrides are written whole, so an older row simply does not carry the newer
 * keys, and returning `undefined` where the type says array hands every caller a
 * crash waiting for a book that has not been re-saved since the upgrade.
 */
function normalise(value: ReadingOverrides): ReadingOverrides {
  return {
    ...value,
    corrections: Array.isArray(value.corrections) ? value.corrections : [],
    headingPrefix: typeof value.headingPrefix === 'string' ? value.headingPrefix : '',
    chapterMarks: Array.isArray(value.chapterMarks) ? value.chapterMarks : [],
  };
}

/**
 * Chapter breaks as the client will store and read them back.
 *
 * Validated *after* the stored snapshot is known, because an absent list means
 * "this client does not know the field", and the answer to that is the breaks
 * already stored rather than an empty list.
 */
function checkedMarks(value: ChapterMark[]): ChapterMark[] {
  if (!Array.isArray(value) || value.length > 200) throw badRequest('invalid chapter marks');
  const ids = new Set<string>();
  for (const mark of value) {
    if (!mark || typeof mark.id !== 'string' || !mark.id || mark.id.length > 100 || ids.has(mark.id)) throw badRequest('invalid chapter mark');
    if (typeof mark.title !== 'string' || !mark.title || mark.title.length > 60 || /[\r\n]/.test(mark.title)) throw badRequest('invalid chapter mark');
    // The quote is matched against the file when the book opens, so it is bounded
    // like a correction's: long enough for a passage, never a whole chapter.
    if (typeof mark.quote !== 'string' || mark.quote.length > 400 || /^\s*$/.test(mark.quote)) throw badRequest('invalid chapter mark');
    if (typeof mark.prefix !== 'string' || mark.prefix.length > 32 || typeof mark.suffix !== 'string' || mark.suffix.length > 32) throw badRequest('invalid chapter mark');
    ids.add(mark.id);
  }
  return value;
}

/** Personal, versioned overlays live beside progress in DATA_DIR; source files are never changed. */
export class ReadingOverrideService {
  constructor(private readonly db: Db) {}
  get(userId: string, bookId: string): ReadingOverrides {
    const row = this.db.get<{ payload: string; version: number }>('SELECT payload,version FROM reading_overrides WHERE user_id=? AND book_id=? ORDER BY version DESC LIMIT 1',userId,bookId);
    return row ? { ...normalise(JSON.parse(row.payload) as ReadingOverrides), version: row.version } : empty();
  }
  save(userId: string, bookId: string, input: ReadingOverrides): ReadingOverrides {
    if (!input || !Number.isSafeInteger(input.version) || typeof input.headingPrefix !== 'string' || input.headingPrefix.length > 60 || /[\r\n]/.test(input.headingPrefix) || !Array.isArray(input.corrections) || input.corrections.length > 500) throw badRequest('invalid reading overrides');
    const ids = new Set<string>();
    for (const correction of input.corrections) {
      const a = correction?.anchor;
      if (!correction || typeof correction.id !== 'string' || !correction.id || correction.id.length > 100 || ids.has(correction.id) || typeof correction.replacement !== 'string' || correction.replacement.length > 4000 || !a || typeof a.sectionId !== 'string' || a.sectionId.length > 4096 || typeof a.quote !== 'string' || !a.quote || a.quote.length > 4000 || typeof a.prefix !== 'string' || a.prefix.length > 32 || typeof a.suffix !== 'string' || a.suffix.length > 32 || !Number.isSafeInteger(a.start) || a.start < 0 || !Number.isSafeInteger(a.end) || a.end <= a.start || a.end - a.start !== a.quote.length) throw badRequest('invalid correction');
      ids.add(correction.id);
    }
    // An absent list is an older client, not an erasure: it never knew the field
    // and sent back only what it understood. Dropping the reader's chapter breaks
    // because an old build saved a typo fix would be the worst of both.
    return this.db.transaction(() => {
      const previous = this.get(userId,bookId);
      if (input.version !== previous.version) throw conflict('整理规则已被另一设备修改，请重新打开后重试');
      const marks = checkedMarks(input.chapterMarks === undefined ? previous.chapterMarks : input.chapterMarks);
      const next = { version: previous.version + 1, headingPrefix: input.headingPrefix, corrections: input.corrections, chapterMarks: marks };
      this.db.run('INSERT INTO reading_overrides(user_id,book_id,version,payload) VALUES(?,?,?,?)',userId,bookId,next.version,JSON.stringify(next));
      return next;
    });
  }
  undo(userId: string, bookId: string, version: number): ReadingOverrides {
    const row = this.db.get<{ payload: string }>('SELECT payload FROM reading_overrides WHERE user_id=? AND book_id=? AND version<? ORDER BY version DESC LIMIT 1',userId,bookId,version);
    return this.save(userId,bookId,{ ...(row ? normalise(JSON.parse(row.payload) as ReadingOverrides) : empty()),version });
  }
}
