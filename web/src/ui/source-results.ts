import type { SourceEntry } from '../api/sources.ts';

export interface SourceResultGroup { key: string; entry: SourceEntry; entries: SourceEntry[] }

const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();

/** 各站写法不一的「没作者」占位词，不能拿来区分是不是同一本书 */
const PLACEHOLDER_AUTHOR = /^(佚名|未知|无名|匿名|作者未知|不详|暂无|待定|none|null|n\/a|-|—|－|？|\?)$/u;

function cleanAuthors(authors: readonly string[] | undefined): string[] {
  return [...new Set((authors ?? []).map(normalize).filter((value) => value && !PLACEHOLDER_AUTHOR.test(value)))].sort();
}

/**
 * 书名相同且作者相容时合并；作者都有但不重叠说明是不同的书，保持分开。
 * 作者缺失或写「佚名」不提供区分信息，按相容处理（主键是书名，作者只做辅助判断）。
 */
function compatible(left: readonly string[], right: readonly string[]): boolean {
  if (!left.length || !right.length) return true;
  return left.some((author) => right.includes(author));
}

/** Group display rows, retaining every opaque reference for detail and acquisition. */
export function groupSourceResults(items: SourceEntry[], merge: boolean): SourceResultGroup[] {
  const groups: SourceResultGroup[] = [];
  const seenRefs = new Set<string>();
  const byTitle = new Map<string, Array<SourceResultGroup & { authors: string[] }>>();

  for (const entry of items) {
    if (seenRefs.has(entry.ref)) continue;
    seenRefs.add(entry.ref);
    const title = normalize(entry.title);
    if (!merge || !title) {
      groups.push({ key: JSON.stringify(['entry', entry.ref]), entry, entries: [entry] });
      continue;
    }
    const authors = cleanAuthors(entry.authors);
    const bucket = byTitle.get(title) ?? [];
    const hit = bucket.find((group) => compatible(group.authors, authors));
    if (hit) {
      hit.entries.push(entry);
      hit.authors = [...new Set([...hit.authors, ...authors])].sort();
      continue;
    }
    const group = {
      key: JSON.stringify(['book', title, authors.join('\u0000'), groups.length]),
      entry,
      entries: [entry],
      authors,
    };
    bucket.push(group);
    byTitle.set(title, bucket);
    groups.push(group);
  }

  return groups.map(({ key, entry, entries }) => ({ key, entry, entries }));
}
