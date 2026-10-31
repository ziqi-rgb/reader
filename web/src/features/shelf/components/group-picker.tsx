import { useEffect, useMemo, useRef, useState } from 'react';
import type { BookGroup } from '../../../api/types.ts';
import {
  groupBlocksUnder,
  groupChildren,
  groupDescendants,
  groupLevel,
  groupPathLabel,
  groupRootOf,
  groupShortName,
  topLevelGroups,
  withAncestors,
} from '../groups.ts';

/**
 * The reader's group tree, as a picker.
 *
 * One implementation for 书籍详情 and 丛书详情, because the two ask the same
 * question — "which groups does this go in?" — about one book and about a 丛书's
 * whole run. 丛书详情 used to draw a flat row of chips: with four levels of
 * `小说.奇幻.剑与魔法` that row could not show the hierarchy, could not tell two
 * same-named tags apart, and could not create anything.
 *
 * The tree is browsed one 大类 at a time. A 大类 chip has two halves: its name
 * switches which 大类 is being shown, and ＋ files into that 大类 itself. 篇幅, tag
 * and the tag's own 细分 then unfold below it.
 *
 * **Selecting closes upwards, cancelling closes downwards.** A book in
 * 「小说.奇幻.剑与魔法」 is also in 「小说.奇幻」 and 「小说」 — the shelf filters a
 * 大类 by its whole subtree, so a leaf-only membership still *finds* the book, but
 * the saved set would then disagree with what the picker shows, and clearing a 大类
 * afterwards would leave the leaf quietly behind. The saved set is therefore the
 * closure: every level the reader can see ticked is in it.
 */
export function GroupPicker({ groups, selected, busy = false, onChange }: {
  groups: readonly BookGroup[];
  selected: readonly string[];
  busy?: boolean;
  onChange(next: string[]): void;
}) {
  const level1 = useMemo(() => topLevelGroups(groups), [groups]);
  const [activeRootId, setActiveRootId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // `groups` arrives from the server, so the first render has nothing to derive a
  // starting 大类 or an unfolded tag from. Both are seeded once, and never again —
  // otherwise every re-render would re-open a tag the reader had just folded.
  const seeded = useRef(false);

  useEffect(() => {
    if (seeded.current || groups.length === 0) return;
    seeded.current = true;
    // The set the picker saves is the closure, so an existing selection that names
    // only a 四级 tag is closed before it is drawn: the chips the reader sees ticked
    // and the groups written on save are then the same set.
    const normalized = withAncestors(groups, selected);
    if (normalized.length !== selected.length) onChange(normalized);
    for (const id of selected) {
      const root = groupRootOf(groups, id);
      if (root) {
        setActiveRootId(current => current ?? root.id);
        break;
      }
    }
    const open = new Set<string>();
    for (const id of selected) {
      const group = groups.find(entry => entry.id === id);
      if (group && groupLevel(group) === 4 && group.parentId) open.add(group.parentId);
    }
    if (open.size > 0) setExpanded(current => (current.size > 0 ? current : open));
  }, [groups, selected, onChange]);

  const activeRoot = level1.find(group => group.id === activeRootId) ?? level1[0];
  const blocks = activeRoot
    ? groupBlocksUnder(groups, activeRoot.id)
    : { second: [], third: [], fourth: [] };

  const toggle = (id: string) => {
    if (busy) return;
    if (selected.includes(id)) {
      // Leaving a group leaves everything under it too: a 四级 tag without its 三级
      // is not a state the tree can draw, and the reader clearing a 大类 means to
      // leave that section.
      const drop = new Set([id, ...groupDescendants(groups, id).map(group => group.id)]);
      onChange(selected.filter(value => !drop.has(value)));
      return;
    }
    onChange(withAncestors(groups, [...selected, id]));
  };

  const toggleExpanded = (id: string) => setExpanded(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  if (groups.length === 0) return <p className="sheet-text muted">还没有分组。</p>;

  return <>
    <div className="chip-row" role="group" aria-label="一级分组">
      {level1.map(group => {
        const chosen = selected.includes(group.id);
        return <span key={group.id} className="chip-split">
          <button type="button" className="chip-split-main" aria-pressed={activeRoot?.id === group.id}
            aria-label={`查看「${group.name}」下的分组`}
            onClick={() => setActiveRootId(group.id)}>{group.name}</button>
          <button type="button" className="chip-split-tail" aria-pressed={chosen}
            aria-label={chosen ? `从「${group.name}」移出` : `归入「${group.name}」`}
            disabled={busy} onClick={() => toggle(group.id)}>{chosen ? '✓' : '＋'}</button>
        </span>;
      })}
    </div>
    {activeRoot && <div className="book-detail-groups">
      <p className="sheet-text muted">「{groupPathLabel(activeRoot.name)}」下的标签</p>
      {blocks.second.length > 0 && <div className="sheet-field">
        <label>二级组<span className="muted">（篇幅，可不选）</span></label>
        <div className="chip-row" role="group" aria-label="二级组">
          {blocks.second.map(group => <button key={group.id} type="button" className="chip"
            aria-pressed={selected.includes(group.id)} disabled={busy}
            aria-label={`${groupPathLabel(group.name)}，${group.bookCount} 本`}
            onClick={() => toggle(group.id)}>{groupShortName(group.name)}</button>)}
        </div>
      </div>}
      {blocks.third.length > 0 && <div className="sheet-field">
        <label>三级组<span className="muted">（tag）</span></label>
        {(() => {
          const closed = blocks.third.filter(group => !expanded.has(group.id));
          const open = blocks.third.filter(group => expanded.has(group.id));
          const chip = (group: BookGroup) => {
            const children = groupChildren(groups, group.id);
            const unfolded = expanded.has(group.id);
            return <span key={group.id} className="chip-split">
              <button type="button" className="chip-split-main" aria-pressed={selected.includes(group.id)}
                disabled={busy} aria-label={`${groupPathLabel(group.name)}，${group.bookCount} 本`}
                onClick={() => toggle(group.id)}>{groupShortName(group.name)}</button>
              {children.length > 0 && <button type="button" className="chip-split-tail" aria-expanded={unfolded}
                aria-label={`${unfolded ? '收起' : '展开'}「${groupShortName(group.name)}」的 ${children.length} 个四级标签`}
                disabled={busy} onClick={() => toggleExpanded(group.id)}>{unfolded ? '‹' : '›'}</button>}
            </span>;
          };
          return <>
            {closed.length > 0 && <div className="chip-row" role="group" aria-label="三级组">
              {closed.map(chip)}
            </div>}
            {/* An unfolded tag takes a row of its own: its 四级标签 sit beside it,
              * parted by rules, and wrap onto another line when the row fills up. */}
            {open.map(group => <div key={group.id} className="book-detail-tag-row">
              {chip(group)}
              <div className="book-detail-subtags" role="group" aria-label={`「${groupShortName(group.name)}」的四级组`}>
                {groupChildren(groups, group.id).map(child => <button key={child.id} type="button"
                  className="book-detail-subtag" aria-pressed={selected.includes(child.id)} disabled={busy}
                  aria-label={`${groupPathLabel(child.name)}，${child.bookCount} 本`}
                  onClick={() => toggle(child.id)}>{groupShortName(child.name)}</button>)}
              </div>
            </div>)}
          </>;
        })()}
      </div>}
    </div>}
  </>;
}
