/**
 * The shelf's own scope: "this row is a book the account can actually open".
 *
 * The shelf asks it of three sources, because the library is not one kind of
 * thing any more:
 *
 *  - `book_files` with `missing = 0` — a scanned file that is still on disk. The
 *    scanner never deletes a row when a file goes away, it flags it (`missing = 1`),
 *    so the flag is the difference between "a book" and "a record of a book".
 *  - `acquired_files` — bytes a provider downloaded into DATA_DIR.
 *  - `chapter_publications` — chapters a provider serves on demand (no file at all).
 *
 * **Callers must alias `user_books` as `ub`.** The account check on a chapter
 * publication is per account (`c.user_id = ub.user_id`), and the column naming the
 * book differs between callers (`b.id` in a list query, `ub.book_id` when counting),
 * so the caller passes that in as `bookId`. Never user input.
 *
 * Why this lives in its own module: the shelf's *counts* and the shelf's *grid* have
 * to use the same definition. 未分组 said 284 while opening it showed nothing,
 * because the count only looked at `user_books` while the list also demanded a live
 * source — the difference being shelf rows whose files had been flagged missing.
 * `groups.ts` and `shelf.ts` both import this, and neither imports the other.
 */
export function shelfScopeSql(bookId: string): string {
  return `(EXISTS (SELECT 1 FROM book_files f WHERE f.book_id = ${bookId} AND f.missing = 0)
        OR EXISTS (SELECT 1 FROM acquired_files a WHERE a.book_id = ${bookId})
        OR EXISTS (SELECT 1 FROM chapter_publications c WHERE c.book_id = ${bookId} AND c.user_id = ub.user_id))`;
}
