import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, ChevronRight, HelpCircle } from 'lucide-react';
import { Callout } from '../../../ui/toolkit.tsx';
import { ActionMenu } from '../../../ui/action-menu.tsx';
import { Sheet } from '../../../ui/sheet.tsx';
import { useRuntime } from '../../../app/providers/runtime-context.tsx';
import { useBookGroups } from '../queries/shelf.queries.ts';
import type { BookGroup } from '../../../api/types.ts';
import { childLevelsOf, flattenGroupTree, groupChildren, groupDescendants, groupPathLabel, groupShortName, groupTree, isManualGroup } from '../groups.ts';
import '../styles/groups.css';

/** What each level means to the reader, used in the create sheet and the pickers. */
const LEVEL_LABELS: Record<number, string> = { 2: '二级（篇幅）', 3: '三级（tag）', 4: '四级（tag 细分）' };

/**
 * 分组管理: the reader's own shelf structure, edited as the tree it is.
 *
 * Separate from 系列 and 标签 on purpose — those come out of the file and a rescan
 * rewrites them. A group is per account and a book may sit in several, so this page
 * owns create / rename / delete while 书籍详情 owns "which groups is *this* book in".
 *
 * The path is still the identity (`小说.奇幻.剑与魔法`, at most three levels), but the
 * reader never types a dot: a new top-level group is made in the form at the top and
 * a child is made from 「新建子分组」 on its parent's row, so the level comes from
 * where the group is, and the list draws it indented under that parent, foldable.
 * Renaming or deleting a group carries its descendants along — their names are
 * built on its own. One top-level group may be marked 默认: the shelf opens on it
 * when no filter is in the URL.
 */
export function GroupsPage() {
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  const groups = useBookGroups();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [renaming, setRenaming] = useState<BookGroup | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleting, setDeleting] = useState<BookGroup | null>(null);
  /** The open 「新建子分组」 sheet: the parent the new group goes under. */
  const [creatingUnder, setCreatingUnder] = useState<BookGroup | null>(null);
  const [childName, setChildName] = useState('');
  /** Which level the new group takes — a tag may sit straight under a 大类. */
  const [childLevel, setChildLevel] = useState(2);
  /** Folded rows; a row is still drawn when folded, only its subtree hides. */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  /** The ⓘ bubble beside the title: hover opens it, a click pins it (phones have no hover). */
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpPinned, setHelpPinned] = useState(false);

  const all = useMemo(() => (groups.data ?? []).filter(isManualGroup), [groups.data]);
  const rows = useMemo(
    () => flattenGroupTree(groupTree(all), id => collapsed.has(id)),
    [all, collapsed],
  );
  const defaultId = all.find(group => group.isDefault)?.id ?? null;

  /**
   * A tap anywhere else closes the bubble: a phone has no `pointerleave`, so
   * without this the only way back to the list would be to press the icon again.
   */
  useEffect(() => {
    if (!helpOpen) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('.groups-help')) return;
      setHelpPinned(false);
      setHelpOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [helpOpen]);

  /**
   * A hover opens the bubble and leaving closes it — unless it was pinned by a
   * click. Toggling `helpOpen` on click would instead *close* what hovering had
   * just opened, which is exactly what a mouse user would see.
   */
  const toggleHelp = () => {
    const next = !helpPinned;
    setHelpPinned(next);
    setHelpOpen(next);
  };

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['book-groups'] }),
      queryClient.invalidateQueries({ queryKey: ['shelf'] }),
    ]);
  };
  const run = async (work: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError('');
    try { await work(); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : fallback); }
    finally { setBusy(false); }
  };
  const create = () => {
    const value = name.trim();
    if (!value) return;
    if (value.includes('.')) {
      setError('这里只建一级分组：名字里不要带「.」。要在某个分组下面分层，用那一行的「新建子分组」。');
      return;
    }
    void run(async () => { await runtime.api.createBookGroup(value); setName(''); }, '创建分组失败');
  };
  const createChild = () => {
    const parent = creatingUnder;
    const value = childName.trim();
    if (!parent || !value) return;
    if (value.includes('.')) {
      setError('子分组只填这一级的名字，不要带「.」；层级由它所在的分组决定。');
      return;
    }
    void run(async () => {
      await runtime.api.createBookGroup(value, { parentId: parent.id, level: childLevel });
      setChildName('');
      setCreatingUnder(null);
      // The new row lives under the parent, so a folded parent has to open.
      setCollapsed(current => {
        if (!current.has(parent.id)) return current;
        const next = new Set(current);
        next.delete(parent.id);
        return next;
      });
    }, '创建分组失败');
  };
  /** Opens 「新建子分组」 at the first level the parent allows. */
  const openChildSheet = (group: BookGroup) => {
    setCreatingUnder(group);
    setChildName('');
    setChildLevel(childLevelsOf(group.level)[0] ?? group.level + 1);
    setError('');
  };
  /** What the new group's path will read as, including the skipped-level placeholder. */
  const childPreview = (parent: BookGroup, value: string) => {
    const gaps = Math.max(0, childLevel - parent.level - 1);
    const segments = [...parent.name.split('.'), ...Array.from({ length: gaps }, () => '-'), value.trim() || '…'];
    return groupPathLabel(segments.join('.'));
  };
  const rename = () => {
    const value = renameValue.trim();
    const target = renaming;
    if (!target || !value) return;
    void run(async () => { await runtime.api.renameBookGroup(target.id, value); setRenaming(null); }, '重命名失败');
  };
  const remove = () => {
    const target = deleting;
    if (!target) return;
    void run(async () => { await runtime.api.deleteBookGroup(target.id); setDeleting(null); }, '删除分组失败');
  };
  const setDefault = (id: string | null) => {
    void run(async () => { await runtime.api.setDefaultBookGroup(id); }, '设置默认分组失败');
  };
  const toggleCollapsed = (id: string) => setCollapsed(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return <div className="sources-screen groups-screen">
    <header className="groups-header">
      <Link className="button" to="/shelf"><ChevronLeft size={16} />书架</Link>
      <h1>分组管理</h1>
      {/*
        * The page's rules live here rather than in three paragraphs above the form:
        * they are read once and then only got in the way of the list.
        */}
      <span className="groups-help"
        onPointerEnter={event => { if (event.pointerType === 'mouse') setHelpOpen(true); }}
        onPointerLeave={event => { if (event.pointerType === 'mouse' && !helpPinned) setHelpOpen(false); }}>
        <button type="button" className="groups-help-trigger" aria-expanded={helpOpen}
          aria-controls="groups-help-panel" aria-label="分组说明"
          onClick={toggleHelp}>
          <HelpCircle size={17} aria-hidden="true" />
        </button>
        {helpOpen && <div id="groups-help-panel" className="groups-help-panel" role="tooltip">
          <p>分组是你自己的书架结构：一本书可以同时在多个分组里，和文件里的系列、标签无关（那两项由文件决定，重新扫描会变）。在书架卡片上长按「书籍详情」可以把书放进分组。</p>
          <p>分组最多三级。新建时只输入这一级的名字：要建一级分组用下面的输入框，要在某个分组下面再分层，就点它那一行的「新建子分组」。改名字或删除时，下面的子分组会跟着一起改、一起删。</p>
          <p>文件夹分组（按书库目录自动归类，例如 <code>故事/长篇/喜剧</code> → <code>故事.长篇.喜剧</code>）跟着文件走，不在这里管理：它们在书架的筛选里直接可用，改名或删除请改文件目录。</p>
        </div>}
      </span>
    </header>
    <main className="groups-body">
      <form className="groups-create" onSubmit={event => { event.preventDefault(); create(); }}>
        <label className="groups-create-field">新建一级分组<input type="search" placeholder="例如：小说" value={name} disabled={busy} onChange={event => setName(event.currentTarget.value)} /></label>
        <button type="submit" className="button primary" disabled={busy || !name.trim()}>新建</button>
      </form>

      {error && <Callout tone="error">{error}</Callout>}
      {groups.error && <Callout tone="error">分组读取失败：{groups.error.message}</Callout>}
      {groups.isPending && <p className="muted">正在读取分组…</p>}
      {!groups.isPending && !groups.error && all.length === 0 && <div className="empty-state"><p>还没有分组</p><p className="muted">在上面输入一个名字就能创建第一个分组。</p></div>}

      <ul className="groups-list">
        {rows.map(group => {
          const childCount = groupChildren(all, group.id).length;
          const folded = collapsed.has(group.id);
          return <li key={group.id} className="groups-row" data-level={group.level}
            style={{ paddingInlineStart: `calc(.5rem + ${(group.level - 1) * 1.4}rem)` }}>
            <div className="groups-row-text">
              {childCount > 0
                ? <button type="button" className="groups-fold" aria-expanded={!folded}
                  aria-label={`${folded ? '展开' : '收起'}「${groupShortName(group.name)}」的 ${childCount} 个子分组`}
                  onClick={() => toggleCollapsed(group.id)}>
                  {folded ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
                </button>
                : <span className="groups-fold-spacer" aria-hidden="true" />}
              <strong title={groupPathLabel(group.name)}>{groupShortName(group.name)}</strong>
              {/* The row leads with the last step; the path says which parent that step is under. */}
              {group.level > 1 && <span className="groups-row-path muted">{groupPathLabel(group.name)}</span>}
              <small className="muted">{group.bookCount} 本{group.subtreeCount > group.bookCount ? ` · 含下级 ${group.subtreeCount} 本` : ''}</small>
              {group.isDefault && <span className="groups-default-mark">默认</span>}
            </div>
            <div className="groups-row-actions">
              <Link className="button" to={`/shelf?groups=${encodeURIComponent(group.id)}`}>查看书架</Link>
              {/* The rest are rare enough to live behind ⋯ — five buttons per row made
                  a phone row three lines tall and the desktop row mostly whitespace. */}
              <ActionMenu label={`「${groupShortName(group.name)}」的操作`} title={groupPathLabel(group.name)} items={[
                group.level < 4 && { label: '新建子分组', onSelect: () => openChildSheet(group) },
                group.level === 1 && (group.isDefault
                  ? { label: '取消默认分组', onSelect: () => setDefault(null) }
                  : { label: '设为默认分组', onSelect: () => setDefault(group.id) }),
                { label: '重命名', onSelect: () => { setRenaming(group); setRenameValue(group.name); } },
                { label: '删除', danger: true, onSelect: () => setDeleting(group) },
              ]} />
            </div>
          </li>;
        })}
      </ul>
    </main>

    {creatingUnder && <Sheet title={`在「${groupShortName(creatingUnder.name)}」下新建分组`} busy={busy} onClose={() => setCreatingUnder(null)}
      footer={<>
        <button type="button" className="button" onClick={() => setCreatingUnder(null)}>取消</button>
        <button type="button" className="button primary" disabled={busy || !childName.trim()} onClick={createChild}>新建</button>
      </>}>
      <div className="sheet-form">
        {childLevelsOf(creatingUnder.level).length > 1 && <div className="sheet-field">
          <label>层级</label>
          <div className="chip-row" role="group" aria-label="层级">
            {childLevelsOf(creatingUnder.level).map(level => <button key={level} type="button" className="chip"
              aria-pressed={childLevel === level} onClick={() => setChildLevel(level)}>{LEVEL_LABELS[level]}</button>)}
          </div>
        </div>}
        <div className="sheet-field"><label htmlFor="group-child-name">名称</label>
          <input id="group-child-name" type="text" value={childName} disabled={busy} placeholder="例如：奇幻"
            onChange={event => setChildName(event.currentTarget.value)} /></div>
        <p className="sheet-text muted">
          它会成为「{childPreview(creatingUnder, childName)}」，作为{LEVEL_LABELS[childLevel] ?? '子分组'}放在这一级的下面。
        </p>
      </div>
    </Sheet>}

    {renaming && <Sheet title="重命名分组" busy={busy} onClose={() => setRenaming(null)}
      footer={<>
        <button type="button" className="button" onClick={() => setRenaming(null)}>取消</button>
        <button type="button" className="button primary" disabled={busy || !renameValue.trim()} onClick={rename}>保存</button>
      </>}>
      <div className="sheet-form">
        <div className="sheet-field"><label htmlFor="group-rename">分组名</label>
          <input id="group-rename" type="text" value={renameValue} disabled={busy} onChange={event => setRenameValue(event.currentTarget.value)} /></div>
        <p className="sheet-text muted">改一级或二级分组时，它下面的子分组会一起改名。</p>
      </div>
    </Sheet>}

    {deleting && <Sheet title="删除分组" busy={busy} onClose={() => setDeleting(null)}
      footer={<>
        <button type="button" className="button" onClick={() => setDeleting(null)}>取消</button>
        <button type="button" className="button primary" disabled={busy} onClick={remove}>删除</button>
      </>}>
      <p className="sheet-text">{deleteWarning(deleting, groupDescendants(all, deleting.id).length, defaultId === deleting.id)}</p>
    </Sheet>}
  </div>;
}

/** What a delete does, in the reader's terms: which groups go and which books stay. */
function deleteWarning(group: BookGroup, descendants: number, isDefault: boolean): string {
  const parts = [`确定删除「${group.name}」吗？`];
  if (descendants > 0) parts.push(`它下面的 ${descendants} 个子分组会一起删除。`);
  if (group.subtreeCount > 0) parts.push(`这些分组里的 ${group.subtreeCount} 本书会留在书架，只是不再属于它们。`);
  else parts.push('这些分组里没有书。');
  if (isDefault) parts.push('它也是书架的默认分组，删除后书架回到全部书籍。');
  return parts.join('');
}
