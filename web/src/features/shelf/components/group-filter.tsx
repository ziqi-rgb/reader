import { useId, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import type { BookGroup, GroupMode } from '../../../api/types.ts';
import { Callout } from '../../../ui/toolkit.tsx';
import { Sheet } from '../../../ui/sheet.tsx';
import {
  groupBlocksUnder, groupFilterIds, groupFilterValue, groupLevel, groupPathLabel, groupRootOf,
  groupShortName, subGroupValuesOf, topLevelGroups, type GroupModes,
} from '../groups.ts';

/**
 * The shelf's group filter, shared with 追更.
 *
 * Both screens are the same question over a different list — "which of my
 * sections" — so they are one component: 一级 chips in the filter row, and the
 * 二级 / 三级 / 四级 blocks in a sheet, each level with its own 或 / 与 / 非. A
 * second copy of this would drift the first time either screen changed.
 */
export function GroupFilterBar({
  groups,
  activeLevel1,
  subFilterCount,
  subFilterLabel = '',
  showCounts = false,
  onToggleLevel1,
  onOpenFilter,
}: {
  groups: readonly BookGroup[];
  activeLevel1: BookGroup | null;
  /** How many sub-group conditions are selected (the 分组 chip's badge). */
  subFilterCount: number;
  /** The names behind those conditions, for the chip's accessible label. */
  subFilterLabel?: string;
  /**
   * Show each top-level group's book count.
   *
   * On the shelf that number *is* the section. In 追更 it would be the shelf count,
   * which says nothing about the list underneath it.
   */
  showCounts?: boolean;
  onToggleLevel1(group: BookGroup): void;
  onOpenFilter(): void;
}) {
  const [level1Open, setLevel1Open] = useState(false);
  const listId = useId();
  const level1Groups = topLevelGroups(groups);
  return <div className="shelf-group-bar">
    <button type="button" className="chip shelf-group-fold" aria-expanded={level1Open}
      aria-controls={listId}
      aria-label={level1Open ? '收起一级组' : '展开一级组'}
      onClick={() => setLevel1Open(open => !open)}>
      {level1Open ? <ChevronLeft size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
    </button>
    {level1Open && <div id={listId} className="chip-row shelf-level1" role="group" aria-label="一级组">
      {level1Groups.map(group => <button key={group.id} type="button" className="chip"
        data-kind={group.kind ?? 'manual'}
        title={group.kind === 'folder'
          ? '按文件夹自动分组，不可修改'
          : group.folderIds?.length ? `同时包含文件夹「${group.name}」里的书` : undefined}
        aria-pressed={activeLevel1?.id === group.id}
        aria-label={showCounts ? `${group.name}，${group.subtreeCount} 本` : group.name}
        onClick={() => onToggleLevel1(group)}>
        {group.name}{showCounts && <span className="muted"> {group.subtreeCount}</span>}
      </button>)}
      {level1Groups.length === 0 && <span className="shelf-level1-empty muted">还没有一级分组</span>}
    </div>}
    <button type="button" className={subFilterCount > 0 ? 'chip shelf-group-active' : 'chip shelf-group'}
      aria-pressed={subFilterCount > 0} aria-haspopup="dialog"
      aria-label={subFilterCount > 0 ? `分组：${subFilterLabel || subFilterCount + ' 个条件'}，点按修改` : '分组筛选'}
      onClick={onOpenFilter}>
      分组{subFilterCount > 0 ? ` · ${subFilterCount}` : ''}
    </button>
  </div>;
}

/**
 * 分组筛选: the sub-group blocks of the section the filter sits under.
 *
 * The draft lives here rather than in the page, so closing the sheet is the same
 * thing as discarding the draft — 「应用」 is the only way out that keeps it.
 */
export function GroupFilterSheet({
  groups,
  selected,
  modes,
  activeLevel1,
  pending = false,
  error,
  showCounts = true,
  extraFooter,
  onApply,
  onClose,
}: {
  groups: readonly BookGroup[];
  /** The current `groups` filter values (a merged chip is one value). */
  selected: readonly string[];
  modes: GroupModes;
  activeLevel1: BookGroup | null;
  pending?: boolean;
  error?: unknown;
  /**
   * Show each group's book count.
   *
   * True on the shelf, where the number *is* the section. False in 追更: those
   * counts are the shelf's, and a chip reading 「奇幻 6」 over a filtered list of
   * one book says the wrong thing.
   */
  showCounts?: boolean;
  /** An extra footer action between 清除分组 and 应用 (管理分组 on the shelf). */
  extraFooter?: ReactNode;
  /** An empty `groups` means 清除分组. */
  onApply(next: { groups: string[]; modes: GroupModes }): void;
  onClose(): void;
}) {
  const [draftGroupIds, setDraftGroupIds] = useState<string[]>(() => subGroupValuesOf(groups, selected));
  const [draftGroupModes, setDraftGroupModes] = useState<GroupModes>(modes);
  const { second: secondLevel, third: thirdLevel, fourth: fourthLevel } = activeLevel1
    ? groupBlocksUnder(groups, activeLevel1.id)
    : { second: [], third: [], fourth: [] };
  /** 或 / 与 / 非, as the chip label. */
  const modeLabel = (mode: GroupMode) => (mode === 'and' ? '与' : mode === 'not' ? '非' : '或');
  /** Which level a chip's `groups` value belongs to (0 when nothing matches). */
  const levelOfFilter = (value: string) => {
    for (const id of groupFilterIds(value)) {
      const group = groups.find(entry => entry.id === id);
      if (group) return groupLevel(group);
    }
    return 0;
  };
  /**
   * A 四级 label, with its tag in brackets when two tags under this 大类 share a name.
   *
   * 「转生」 under 「剑与魔法」 and 「转生」 under 「异世界」 are different groups; the
   * short name alone would make the reader pick one at random.
   */
  const fourthLabel = (group: BookGroup) => {
    const short = groupShortName(group.name);
    const clashes = groups.some(other => other.id !== group.id
      && groupLevel(other) === 4
      && groupShortName(other.name) === short
      && groupRootOf(groups, other.id)?.id === activeLevel1?.id);
    if (!clashes) return short;
    const parentShort = group.name.split('.').slice(0, -1).filter(segment => segment !== '-').pop();
    return parentShort ? `${short}（${parentShort}）` : short;
  };
  const toggleDraftGroup = (value: string) => setDraftGroupIds(current => (current.includes(value)
    ? current.filter(entry => entry !== value)
    : [...current, value]));
  /**
   * 或 / 与 / 非 for one level, shown under its chips once something is selected.
   *
   * Each level answers a different question (篇幅, tag, tag 细分), so each gets its
   * own mode; the levels are AND-ed together by the server. 「与」 needs two or more
   * selected groups to mean anything; 「非」 reads fine on a single one.
   */
  const modeRow = (level: 2 | 3 | 4) => {
    const count = draftGroupIds.filter(value => levelOfFilter(value) === level).length;
    if (count === 0) return null;
    return <div className="chip-row sheet-mode-row" role="group" aria-label={`${level} 级组合方式`}>
      {(['or', 'and', 'not'] as const).map(mode => <button key={mode} type="button" className="chip"
        aria-pressed={draftGroupModes[level] === mode}
        disabled={mode === 'and' && count < 2}
        aria-label={`${level} 级：${mode === 'and' ? '同时属于全部所选' : mode === 'not' ? '不属于任何一个所选' : '属于任一所选'}`}
        onClick={() => setDraftGroupModes(current => ({ ...current, [level]: mode }))}>{modeLabel(mode)}</button>)}
    </div>;
  };
  const chip = (group: BookGroup, level: 2 | 3 | 4) => <button key={group.id} type="button" className="chip"
    data-kind={group.kind ?? 'manual'}
    aria-pressed={draftGroupIds.includes(groupFilterValue(group))}
    title={group.kind === 'folder'
      ? `${group.name}（按文件夹自动分组）`
      : level === 2 ? undefined : groupPathLabel(group.name)}
    aria-label={showCounts ? `${group.name}，${group.subtreeCount} 本` : groupPathLabel(group.name)}
    onClick={() => toggleDraftGroup(groupFilterValue(group))}>
    {level === 4 ? fourthLabel(group) : groupShortName(group.name)}{showCounts && <span className="muted"> {group.subtreeCount}</span>}
  </button>;
  const apply = () => {
    // No subgroup picked means the whole section, which is the top-level group itself.
    const next = draftGroupIds.length > 0
      ? draftGroupIds
      : activeLevel1 ? [groupFilterValue(activeLevel1)] : [];
    onApply({ groups: next, modes: draftGroupModes });
  };
  return <Sheet title="分组筛选" subtitle={activeLevel1 ? `${activeLevel1.name} 下的分组` : '先选一个一级组'} onClose={onClose}
    footer={<>
      <button type="button" className="button" onClick={() => onApply({ groups: [], modes: draftGroupModes })}>清除分组</button>
      {extraFooter}
      <button type="button" className="button primary" disabled={!activeLevel1 && groups.length > 0} onClick={apply}>应用</button>
    </>}>
    <div className="sheet-form">
      {pending && <p className="sheet-text muted">正在读取分组…</p>}
      {error ? <Callout tone="error">分组读取失败：{error instanceof Error ? error.message : String(error)}</Callout> : null}
      {!pending && !error && groups.length === 0 && <div className="sheet-text">
        <p>还没有分组。分组是你自己的书架结构，和文件里的系列、标签无关。</p>
      </div>}
      {!pending && !error && groups.length > 0 && !activeLevel1 && <p className="sheet-text muted">
        先在筛选行展开一级组（左侧的箭头）并选一个，这里就会列出它的二级、三级、四级分组。
      </p>}
      {activeLevel1?.kind === 'unfiled' && <p className="sheet-text muted">
        「{activeLevel1.name}」= 还没有放进任何分组的书。它没有下级分组，选它再点「应用」就能把这些书单独挑出来。
      </p>}
      {activeLevel1 && activeLevel1.kind !== 'unfiled' && <>
        <div className="sheet-field">
          <label>二级组<span className="muted">（可不选）</span></label>
          {secondLevel.length > 0
            ? <div className="chip-row" role="group" aria-label="二级组">{secondLevel.map(group => chip(group, 2))}</div>
            : <p className="sheet-text muted">这个一级组下还没有二级分组。</p>}
          {modeRow(2)}
        </div>
        <div className="sheet-field">
          <label>三级组<span className="muted">（可不选）</span></label>
          {thirdLevel.length > 0
            ? <div className="chip-row" role="group" aria-label="三级组">{thirdLevel.map(group => chip(group, 3))}</div>
            : <p className="sheet-text muted">还没有三级分组。</p>}
          {modeRow(3)}
        </div>
        <div className="sheet-field">
          <label>四级组<span className="muted">（可不选）</span></label>
          {fourthLevel.length > 0
            ? <div className="chip-row" role="group" aria-label="四级组">{fourthLevel.map(group => chip(group, 4))}</div>
            : <p className="sheet-text muted">还没有四级分组。</p>}
          {modeRow(4)}
        </div>
        <div className="sheet-field">
          <p className="sheet-text muted">每一级各选各的或 / 与 / 非，级与级之间取交集（例如「二级 或 长篇」+「三级 非 学院」）。不选就是整个「{activeLevel1.name}」。</p>
        </div>
      </>}
    </div>
  </Sheet>;
}
