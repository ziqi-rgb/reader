import { expect, it } from 'vitest';
import { groupSourceResults } from '../src/ui/source-results.ts';

it('groups normalized titles and author sets but preserves each unique reference', () => {
  const entries = [
    { ref: 'a', title: 'Ａ书', authors: ['作者甲', '作者乙'] },
    { ref: 'b', title: 'A 书', authors: ['作者乙', '作者甲'] },
    { ref: 'c', title: 'A书', authors: ['另一作者'] },
    { ref: 'd', title: 'A书' }, { ref: 'e', title: 'A书', authors: [' '] },
  ];
  const groups = groupSourceResults([...entries, entries[0]!], true);
  // 书名相同：作者重叠的 a/b 与「没有作者信息」的 d/e 合并；作者不同的 c 单独一组
  expect(groups).toHaveLength(2);
  expect(groups[0]!.entries.map(entry => entry.ref)).toEqual(['a', 'b', 'd', 'e']);
  expect(groups[1]!.entries.map(entry => entry.ref)).toEqual(['c']);
  expect(groupSourceResults(entries, false)).toHaveLength(5);
});

it('treats placeholder authors (佚名) as missing instead of a separate book', () => {
  const entries = [
    { ref: 'a', title: '某书', authors: ['烽火戏诸侯'] },
    { ref: 'b', title: '某书', authors: ['佚名'] },
    { ref: 'c', title: '某书', authors: ['作者未知'] },
    { ref: 'd', title: '某书', authors: ['另一位作者'] },
  ];
  const groups = groupSourceResults(entries, true);
  expect(groups).toHaveLength(2);
  expect(groups[0]!.entries.map(entry => entry.ref)).toEqual(['a', 'b', 'c']);
  expect(groups[1]!.entries.map(entry => entry.ref)).toEqual(['d']);
});

it('keeps identically titled books by different authors apart', () => {
  const entries = [
    { ref: 'a', title: '同名书', authors: ['张三'] },
    { ref: 'b', title: '同名书', authors: ['李四'] },
    { ref: 'c', title: '同名书', authors: ['张三', '李四'] },
  ];
  const groups = groupSourceResults(entries, true);
  expect(groups).toHaveLength(2);
  expect(groups[0]!.entries.map(entry => entry.ref)).toEqual(['a', 'c']);
  expect(groups[1]!.entries.map(entry => entry.ref)).toEqual(['b']);
});
