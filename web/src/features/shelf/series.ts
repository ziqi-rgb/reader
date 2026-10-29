import type { Book, ContinueReadingItem } from '../../api/types.ts';

/**
 * A run of same-series books, collapsed into one shelf slot.
 *
 * Kept as a plain wrapper rather than a synthetic `Book` so no caller can
 * mistake it for a real id: the `'id' in entry` test is what every renderer
 * branches on.
 */
export interface SeriesGroup { series: Book[] }

export type ShelfEntry = Book | ContinueReadingItem | SeriesGroup;

/**
 * Folds same-`series` books (two or more) into one entry, preserving shelf order
 * and returning every other item untouched.
 *
 * Shared by the shelf and the home rail: the home page used to draw its preview
 * with the raw list, so a 丛书 that the shelf showed as one stack appeared there
 * as its separate volumes — the same books, two different shapes.
 */
export function foldSeries(items: readonly (Book | ContinueReadingItem)[]): ShelfEntry[] {
  const bySeries = new Map<string, Book[]>();
  for (const item of items) {
    if ('series' in item && item.series) {
      const list = bySeries.get(item.series) ?? [];
      list.push(item);
      bySeries.set(item.series, list);
    }
  }
  const out: ShelfEntry[] = [];
  const emitted = new Set<string>();
  for (const item of items) {
    const series = 'series' in item ? item.series : '';
    if (series && (bySeries.get(series)?.length ?? 0) > 1) {
      if (emitted.has(series)) continue;
      emitted.add(series);
      out.push({ series: [...bySeries.get(series)!].sort((a, b) => (a.seriesIndex ?? 0) - (b.seriesIndex ?? 0)) });
    } else {
      out.push(item);
    }
  }
  return out;
}
