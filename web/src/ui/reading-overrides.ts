import { anchorRange } from './text-anchor.ts';
import type { ReadingOverrides } from '../api/types.ts';
export type { ReadingOverrides } from '../api/types.ts';
export const emptyOverrides = (): ReadingOverrides => ({ version: 0, corrections: [], headingPrefix: '', chapterMarks: [] });

/**
 * A stored or fetched overrides object, with every field present.
 *
 * The object is written whole, so any client or server older than a field simply
 * does not carry it — and a book that has not been re-saved since an upgrade
 * would hand the reader `undefined` where the code expects a list. Reading it
 * through here keeps that one missing key from becoming a crash on the way in.
 */
export function normaliseOverrides(value: ReadingOverrides | null | undefined): ReadingOverrides {
  if (!value) return emptyOverrides();
  return {
    version: Number.isSafeInteger(value.version) ? value.version : 0,
    corrections: Array.isArray(value.corrections) ? value.corrections : [],
    headingPrefix: typeof value.headingPrefix === 'string' ? value.headingPrefix : '',
    chapterMarks: Array.isArray(value.chapterMarks) ? value.chapterMarks : [],
  };
}

/** Apply only exact anchored text; inserting text nodes never executes replacement markup. */
export function applyCorrections(root: HTMLElement, sectionId: string, overrides: ReadingOverrides): number {
  let applied = 0;
  const normal = (id: string) => id.replace(/^xhtml:/, '');
  for (const c of overrides.corrections.filter(c => normal(c.anchor.sectionId) === normal(sectionId))) {
    const range = anchorRange(root,c.anchor);
    if (!range || range.toString() !== c.anchor.quote) continue;
    range.deleteContents(); range.insertNode(document.createTextNode(c.replacement)); applied++;
  }
  return applied;
}
