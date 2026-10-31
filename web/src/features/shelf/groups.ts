import type { Book, BookGroup, BookGroupRef, GroupMode } from '../../api/types.ts';

/** One 或 / 与 / 非 per level: 二级 (篇幅), 三级 (tag), 四级 (tag 细分). */
export interface GroupModes { 2: GroupMode; 3: GroupMode; 4: GroupMode }

/**
 * The reader's shelf tree, as pure functions.
 *
 * A group's name *is* its path (「小说.奇幻.剑与魔法」), so everything the shelf and
 * the management page need — the top-level buttons, the two blocks of a filter
 * sheet, the indentation of a row — is derived here rather than in the components.
 * The server also sends `level`/`parentId`; those are trusted first and the name is
 * the fallback, so a row written by an older build still lands somewhere sensible.
 */
export const GROUP_PATH_SEPARATOR = '.';

/**
 * A level that was skipped when a group was created (a tag under a 大类).
 *
 * Stored in the name so the level stays readable — 「小说.-.奇幻」 is three levels —
 * but drawn as 「⋯」 and never accepted as a name.
 */
export const GROUP_LEVEL_PLACEHOLDER = '-';

export function groupSegments(name: string): string[] {
  return name.split(GROUP_PATH_SEPARATOR).map((segment) => segment.trim());
}

export function groupLevelOf(name: string): number {
  return groupSegments(name).length;
}

/**
 * 「小说.奇幻.剑与魔法」 → 「剑与魔法」.
 *
 * A chip only needs the last step: the block it sits in already names the parents,
 * and drawing the whole path there would read as one long stacked label.
 */
export function groupShortName(name: string): string {
  const segments = groupSegments(name);
  return segments[segments.length - 1] || name;
}

export function isInGroupSubtree(name: string, root: string): boolean {
  return name === root || name.startsWith(root + GROUP_PATH_SEPARATOR);
}

/**
 * A group the reader made: neither a folder group nor 未分组.
 *
 * The two derived kinds are read-only and are never offered where a group is
 * *chosen* (书籍详情, 丛书详情, 分组管理) — only where a filter selects one.
 */
export function isManualGroup(group: Pick<BookGroup, 'kind'>): boolean {
  return group.kind !== 'folder' && group.kind !== 'unfiled';
}

/**
 * The groups a 丛书 inherits from its volumes.
 *
 * A 丛书 is not a row: it is a stack of books sharing a `series`, so what it sits
 * in is what its volumes sit in. The *union*, not the intersection — a stack whose
 * volumes were filed differently still belongs to every section any of them
 * belongs to, while an intersection opened the sheet with nothing selected and
 * saving that empty selection wiped the groups the volumes had.
 *
 * `manual` is the writable selection (the reader's own groups, which a 丛书 detail
 * writes to every volume). `folders` are the folder groups the stack inherits from
 * the filesystem: shown and filtered, never written, because they describe where
 * the files are rather than what the reader decided.
 */
export function inheritedGroupsOf(books: readonly Pick<Book, 'groups'>[]): {
  manual: string[];
  folders: BookGroupRef[];
} {
  const manual = new Set<string>();
  const folders = new Map<string, BookGroupRef>();
  for (const book of books) {
    for (const group of book.groups ?? []) {
      if (group.kind === 'folder') folders.set(group.id, group);
      else if (group.kind !== 'unfiled') manual.add(group.id);
    }
  }
  return { manual: [...manual], folders: [...folders.values()] };
}

/**
 * The group one level up, skipping a skipped level.
 *
 * 「小说.奇幻.剑与魔法」 → 「小说.奇幻」, and 「小说.-.奇幻」 → 「小说」: the placeholder
 * is a level, not a group. Mirrors `groupParentName` in
 * `server/src/services/groups.ts` — the server owns the stored tree, but the
 * picker has to walk the same path to know which ancestors a selection implies,
 * and the two must not disagree about what 「-」 means.
 */
export function groupParentName(name: string): string | null {
  const segments = groupSegments(name);
  let depth = segments.length - 1;
  while (depth > 0 && segments[depth - 1] === GROUP_LEVEL_PLACEHOLDER) depth -= 1;
  return depth > 0 ? segments.slice(0, depth).join(GROUP_PATH_SEPARATOR) : null;
}

/**
 * The groups above `id`, nearest first.
 *
 * Choosing a 四级 tag means the book is in that tag *and* in the 篇幅 and 大类 it
 * hangs off: 「在 小说.奇幻.剑与魔法 里」 is not something a shelf can hold without
 * the book also being in 小说. A stored set that named only the leaf still filters
 * correctly (the server expands a selection down its subtree), but it would say
 * something different from what the picker shows, and clearing a 大类 afterwards
 * would leave the leaf silently behind.
 */
export function groupAncestors(groups: readonly BookGroup[], id: string): BookGroup[] {
  const out: BookGroup[] = [];
  const seen = new Set<string>([id]);
  let current = groups.find(group => group.id === id)?.name;
  while (current) {
    const parentName = groupParentName(current);
    if (!parentName || seen.has(parentName.toLowerCase())) break;
    seen.add(parentName.toLowerCase());
    const parent = groups.find(group => group.name.toLowerCase() === parentName.toLowerCase());
    if (!parent) break;
    out.push(parent);
    current = parent.name;
  }
  return out;
}

/**
 * `ids` closed upwards: every group a selection implies by sitting under it.
 *
 * The set a picker shows and the set it saves have to be the same one, so this is
 * the single definition of "and its ancestors" — used when a chip is ticked and
 * when an existing selection is read back (an older membership may name only a
 * 四级 tag).
 */
export function withAncestors(groups: readonly BookGroup[], ids: readonly string[]): string[] {
  const out = new Set(ids);
  for (const id of ids) for (const ancestor of groupAncestors(groups, id)) out.add(ancestor.id);
  return [...out];
}

/**
 * The group's own count as the reader wants it: cards when 「丛书算一本」 is on,
 * files otherwise.
 *
 * Both numbers come from the server (see `BookGroup.slotCount`), so the switch is
 * instant and there is exactly one definition of a slot — the one the shelf pages by.
 */
export function countedGroup(group: BookGroup, seriesAsOne: boolean): number {
  return seriesAsOne ? group.slotCount ?? group.bookCount : group.bookCount;
}

/** The same choice for "everything below this group". */
export function countedSubtree(group: BookGroup, seriesAsOne: boolean): number {
  return seriesAsOne ? group.subtreeSlotCount ?? group.subtreeCount : group.subtreeCount;
}

/** The name a child gets when it is created *under* a group: the parent's path plus one step. */export function childGroupName(parentName: string, child: string): string {
  return `${parentName}${GROUP_PATH_SEPARATOR}${child.trim()}`;
}

/**
 * The `groups` value one chip writes.
 *
 * A chip can stand for a manual group and the folder group of the same name (the
 * server merges them — see `/api/v1/groups`); the parts are joined by `+`, which
 * the server turns into one OR-ed condition, so 与 / 非 still count the chip once.
 */
export function groupFilterValue(group: BookGroup): string {
  return [group.id, ...(group.folderIds ?? [])].join('+');
}

/** The ids behind one `groups` value (a merged chip has more than one). */
export function groupFilterIds(value: string): string[] {
  return value.split('+').map((part) => part.trim()).filter(Boolean);
}

export function topLevelGroups(groups: readonly BookGroup[]): BookGroup[] {
  return groups.filter((group) => groupLevelOf(group.name) === 1);
}

export function defaultGroup(groups: readonly BookGroup[]): BookGroup | undefined {
  return groups.find((group) => group.isDefault);
}

export function groupDescendants(groups: readonly BookGroup[], id: string): BookGroup[] {
  const root = groups.find((group) => group.id === id);
  if (!root) return [];
  return groups.filter((group) => group.id !== id && isInGroupSubtree(group.name, root.name));
}

export function groupChildren(groups: readonly BookGroup[], id: string): BookGroup[] {
  return groups.filter((group) => group.parentId === id);
}

/**
 * The top-level group a selection sits under.
 *
 * A URL may name a subgroup directly (`?groups=<id>`), and the shelf still has to
 * know which section it belongs to: that is which top-level button is pressed and
 * which two blocks the filter sheet offers.
 */
export function groupRootOf(groups: readonly BookGroup[], id: string): BookGroup | undefined {
  const group = groups.find((entry) => entry.id === id);
  if (!group) return undefined;
  if (groupLevelOf(group.name) <= 1) return group;
  const rootName = groupSegments(group.name)[0];
  return groups.find((entry) => groupLevelOf(entry.name) === 1 && entry.name.toLowerCase() === rootName.toLowerCase());
}

/** The level a group sits at; the server sends it, the name is the fallback. */
export function groupLevel(group: Pick<BookGroup, 'level' | 'name'>): number {
  return group.level ?? groupLevelOf(group.name);
}

/**
 * The top-level group a whole selection sits under.
 *
 * A `groups` filter may name a subgroup directly, and both the shelf and 追更
 * still have to know which section that is: it is which top-level chip is pressed
 * and which blocks the filter sheet offers. A merged chip carries more than one id
 * (`a+folder:x`), so the ids are split before they are matched.
 */
export function activeTopGroupOf(groups: readonly BookGroup[], selected: readonly string[]): BookGroup | null {
  const first = selected
    .flatMap(groupFilterIds)
    .map(id => groups.find(group => group.id === id))
    .find((group): group is BookGroup => Boolean(group));
  return first ? groupRootOf(groups, first.id) ?? null : null;
}

/**
 * The sub-group chips of a selection — everything below the top level, as `groups`
 * values (one value per chip, because a merged chip is one condition).
 *
 * A value with no group behind it (a deleted group still in the URL) counts as a
 * filter, not as a top-level chip: the chip has to keep saying something is
 * selected. A merged value counts as top-level when any of its parts is.
 */
export function subGroupValuesOf(groups: readonly BookGroup[], selected: readonly string[]): string[] {
  return selected.filter(value => {
    const found = groupFilterIds(value)
      .map(id => groups.find(entry => entry.id === id))
      .filter((group): group is BookGroup => Boolean(group));
    if (found.length === 0) return true;
    return !found.some(group => groupLevel(group) === 1);
  });
}

/** The two blocks the filter sheet draws: second-level and third-level groups. */
export function groupBlocksUnder(groups: readonly BookGroup[], rootId: string): { second: BookGroup[]; third: BookGroup[]; fourth: BookGroup[] } {
  const descendants = groupDescendants(groups, rootId);
  return {
    second: descendants.filter((group) => groupLevel(group) === 2),
    third: descendants.filter((group) => groupLevel(group) === 3),
    fourth: descendants.filter((group) => groupLevel(group) === 4),
  };
}

/**
 * Which levels may be created under a group: 二级 under 一级, 三级 under 一/二级,
 * 四级 under 三级. A tag may skip the 篇幅 level, a 四级 may not skip the tag.
 */
export function childLevelsOf(level: number): number[] {
  if (level === 1) return [2, 3];
  if (level === 2) return [3];
  if (level === 3) return [4];
  return [];
}

/** 「小说.-.奇幻」 → 「小说.⋯.奇幻」: the page shows the skipped level, storage keeps 「-」. */
export function groupPathLabel(name: string): string {
  return groupSegments(name)
    .map((segment) => (segment === GROUP_LEVEL_PLACEHOLDER ? '⋯' : segment))
    .join(GROUP_PATH_SEPARATOR);
}

export interface GroupTreeNode {
  group: BookGroup;
  children: GroupTreeNode[];
}

/**
 * The tree in drawing order.
 *
 * Parents are placed by `parentId`; a group whose parent is missing (an old row, or
 * a response from an older build) is shown at the top rather than dropped, so a
 * reader can still rename or delete it.
 */
export function groupTree(groups: readonly BookGroup[]): GroupTreeNode[] {
  const known = new Set(groups.map((group) => group.id));
  const byParent = new Map<string, BookGroup[]>();
  const roots: BookGroup[] = [];
  for (const group of groups) {
    if (group.parentId && known.has(group.parentId)) {
      const list = byParent.get(group.parentId) ?? [];
      list.push(group);
      byParent.set(group.parentId, list);
    } else {
      roots.push(group);
    }
  }
  const build = (group: BookGroup): GroupTreeNode => ({
    group,
    children: (byParent.get(group.id) ?? []).map(build),
  });
  return roots.map(build);
}

/**
 * One row per visible group, parents before children.
 *
 * `isCollapsed` hides a row's subtree but never the row itself — that row is the
 * handle that reopens it, so folding it away would leave nothing to press.
 */
export function flattenGroupTree(
  nodes: readonly GroupTreeNode[],
  isCollapsed?: (id: string) => boolean,
): BookGroup[] {
  const flat: BookGroup[] = [];
  const walk = (list: readonly GroupTreeNode[]) => {
    for (const node of list) {
      flat.push(node.group);
      if (!isCollapsed?.(node.group.id)) walk(node.children);
    }
  };
  walk(nodes);
  return flat;
}
