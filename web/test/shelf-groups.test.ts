import { describe, expect, it } from 'vitest';
import {
  activeTopGroupOf,
  childGroupName,
  childLevelsOf,
  defaultGroup,
  flattenGroupTree,
  groupBlocksUnder,
  groupChildren,
  groupDescendants,
  groupFilterIds,
  groupFilterValue,
  groupLevel,
  groupLevelOf,
  groupPathLabel,
  groupRootOf,
  groupShortName,
  groupTree,
  isInGroupSubtree,
  subGroupValuesOf,
  topLevelGroups,
} from '../src/features/shelf/groups.ts';
import type { BookGroup } from '../src/api/types.ts';

/** A group as the server sends it; `level`/`parentId` follow the path. */
const group = (id: string, name: string, extra: Partial<BookGroup> = {}): BookGroup => ({
  id,
  name,
  bookCount: 0,
  subtreeCount: 0,
  level: name.split('.').length,
  parentId: null,
  isDefault: false,
  ...extra,
});

const groups: BookGroup[] = [
  group('n', '小说', { subtreeCount: 4 }),
  group('n-f', '小说.奇幻', { parentId: 'n', subtreeCount: 2 }),
  group('n-f-s', '小说.奇幻.剑与魔法', { parentId: 'n-f', subtreeCount: 1 }),
  group('n-h', '小说.恐怖', { parentId: 'n' }),
  group('n2', '小说家'), // a sibling whose name only *looks* like a child
  group('s', '科幻', { subtreeCount: 1, isDefault: true }),
];

describe('group paths', () => {
  it('reads a name as a path of at most three steps', () => {
    expect(groupLevelOf('小说')).toBe(1);
    expect(groupLevelOf('小说.奇幻')).toBe(2);
    expect(groupLevelOf('小说.奇幻.剑与魔法')).toBe(3);
  });

  it('draws only the last step inside a block that already names the parents', () => {
    expect(groupShortName('小说')).toBe('小说');
    expect(groupShortName('小说.奇幻')).toBe('奇幻');
    expect(groupShortName('小说.奇幻.剑与魔法')).toBe('剑与魔法');
  });

  it('matches a subtree on the dot boundary, not on a shared prefix', () => {
    expect(isInGroupSubtree('小说', '小说')).toBe(true);
    expect(isInGroupSubtree('小说.奇幻', '小说')).toBe(true);
    expect(isInGroupSubtree('小说家', '小说')).toBe(false);
    expect(isInGroupSubtree('小说.奇幻', '小说.恐怖')).toBe(false);
  });

  it('builds a child name from where the group is, not from a typed dot', () => {
    expect(childGroupName('小说', '奇幻')).toBe('小说.奇幻');
    expect(childGroupName('小说.奇幻', ' 剑与魔法 ')).toBe('小说.奇幻.剑与魔法');
  });

  it('writes one chip as its group plus the folder groups merged into it', () => {
    expect(groupFilterValue(group('n', '小说'))).toBe('n');
    expect(groupFilterValue({ ...group('n', '小说'), folderIds: ['folder:小说'] })).toBe('n+folder:小说');
    expect(groupFilterIds('n+folder:小说')).toEqual(['n', 'folder:小说']);
    expect(groupFilterIds('n')).toEqual(['n']);
  });
});

describe('group tree', () => {
  it('separates the top level from everything below it', () => {
    expect(topLevelGroups(groups).map(entry => entry.name)).toEqual(['小说', '小说家', '科幻']);
    expect(groupDescendants(groups, 'n').map(entry => entry.name))
      .toEqual(['小说.奇幻', '小说.奇幻.剑与魔法', '小说.恐怖']);
    expect(groupChildren(groups, 'n').map(entry => entry.name)).toEqual(['小说.奇幻', '小说.恐怖']);
  });

  it('splits one section into the blocks the filter sheet draws', () => {
    expect(groupBlocksUnder(groups, 'n')).toEqual({
      second: [groups[1], groups[3]],
      third: [groups[2]],
      fourth: [],
    });
  });

  it('knows which levels may be created under a group', () => {
    expect(childLevelsOf(1)).toEqual([2, 3]);
    expect(childLevelsOf(2)).toEqual([3]);
    expect(childLevelsOf(3)).toEqual([4]);
    expect(childLevelsOf(4)).toEqual([]);
  });

  it('draws a skipped level as ⋯ but keeps the level it stands for', () => {
    const tag = group('t', '小说.-.奇幻');
    expect(groupLevel(tag)).toBe(3);
    expect(groupPathLabel('小说.-.奇幻')).toBe('小说.⋯.奇幻');
    expect(groupShortName('小说.-.奇幻')).toBe('奇幻');
    expect(groupBlocksUnder([...groups, tag], 'n').third).toContainEqual(tag);
  });

  it('finds the top-level group a subgroup belongs to', () => {
    expect(groupRootOf(groups, 'n-f-s')?.id).toBe('n');
    expect(groupRootOf(groups, 's')?.id).toBe('s');
    expect(groupRootOf(groups, 'gone')).toBeUndefined();
  });

  it('draws parents before children, and keeps a group whose parent is missing', () => {
    const orphan = group('x', '孤儿.子组');
    const tree = groupTree([...groups, orphan]);
    expect(tree.map(node => node.group.name)).toEqual(['小说', '小说家', '科幻', '孤儿.子组']);
    expect(tree[0].children.map(node => node.group.name)).toEqual(['小说.奇幻', '小说.恐怖']);
    expect(flattenGroupTree(tree).map(entry => entry.name))
      .toEqual(['小说', '小说.奇幻', '小说.奇幻.剑与魔法', '小说.恐怖', '小说家', '科幻', '孤儿.子组']);
  });

  it('folds a subtree but keeps the folded row itself', () => {
    const tree = groupTree(groups);
    // The folded row is the handle that reopens it, so it always stays on screen.
    expect(flattenGroupTree(tree, id => id === 'n').map(entry => entry.name))
      .toEqual(['小说', '小说家', '科幻']);
    expect(flattenGroupTree(tree, id => id === 'n-f').map(entry => entry.name))
      .toEqual(['小说', '小说.奇幻', '小说.恐怖', '小说家', '科幻']);
  });

  it('knows which group the shelf opens with', () => {
    expect(defaultGroup(groups)?.name).toBe('科幻');
    expect(defaultGroup(groups.filter(entry => !entry.isDefault))).toBeUndefined();
  });
});

describe('what a selection means', () => {
  it('reads the section a whole selection sits under', () => {
    // A URL may name a subgroup directly; the top-level chip is derived from it.
    expect(activeTopGroupOf(groups, ['n-f-s'])?.id).toBe('n');
    expect(activeTopGroupOf(groups, ['s'])?.id).toBe('s');
    // A merged chip carries a folder id next to the manual one.
    expect(activeTopGroupOf(groups, ['n-f+folder:小说.奇幻'])?.id).toBe('n');
    expect(activeTopGroupOf(groups, [])).toBeNull();
    expect(activeTopGroupOf(groups, ['gone'])).toBeNull();
  });

  it('keeps the sub-group conditions apart from the top-level chip', () => {
    // Only the sub-groups are the 分组 chip's own count; the section is a chip of
    // its own in the filter row.
    expect(subGroupValuesOf(groups, ['n'])).toEqual([]);
    expect(subGroupValuesOf(groups, ['n', 'n-f', 'n-f-s'])).toEqual(['n-f', 'n-f-s']);
    // A value with no group behind it (deleted, still in the URL) still counts.
    expect(subGroupValuesOf(groups, ['gone'])).toEqual(['gone']);
  });
});
