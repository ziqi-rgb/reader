import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Sheet } from '../../../ui/sheet.tsx';
import { Callout } from '../../../ui/toolkit.tsx';
import type { Book, BookGroup } from '../../../api/types.ts';
import { groupBlocksUnder, groupChildren, groupPathLabel, groupRootOf, groupShortName, topLevelGroups } from '../groups.ts';

/** What the sheet hands back on save; a `null` clears the field's override. */
export interface BookMetadataDraft {
  title: string;
  author: string;
  description: string;
  series: string;
  seriesIndex: number | null;
}

const EDITABLE_FIELDS = ['title', 'author', 'description', 'series'] as const;
type EditableField = typeof EDITABLE_FIELDS[number];

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * 书籍详情 / 编辑: the shelf's own view of one book.
 *
 * The card menu is the entry point, so this has to answer everything a reader wants
 * to change about *this* book without opening it: 书名, 作者, and which of their
 * groups it belongs to (several at once — groups are many-to-many). 丛书 stays here
 * too because it is embedded metadata the reader may have to correct, not because it
 * is a grouping dimension any more.
 *
 * Groups are shown one level at a time, because a tree of four levels flattened into
 * chips is unreadable: the top-level rows are a browser (which 大类 you are looking
 * at) with a small ＋ that files the book into that 大类 itself, then the levels
 * under it — 篇幅, tag, and the tag's own 细分, which unfold from a `›` on the tag
 * chip rather than being drawn all at once.
 *
 * Every field the reader has overridden by hand (`book.manualFields`) offers 撤销手改,
 * which falls back to whatever the file carries — that is the only way back once a
 * rescan has overruled.
 */
export function BookDetailSheet({ book, groups, busy, error, onSave, onClearField, onClose }: {
  book: Book;
  groups: BookGroup[];
  busy: boolean;
  error: string;
  onSave(draft: BookMetadataDraft, groupIds: string[]): void;
  onClearField(field: EditableField): void;
  onClose(): void;
}) {
  const [title, setTitle] = useState(book.title ?? '');
  const [author, setAuthor] = useState(book.author ?? '');
  const [description, setDescription] = useState(book.description ?? '');
  const [series, setSeries] = useState(book.series ?? '');
  const [index, setIndex] = useState(book.seriesIndex == null ? '' : String(book.seriesIndex));
  const [selected, setSelected] = useState<string[]>(() => (book.groups ?? [])
    // A folder group describes the file layout, so it is shown but never written.
    .filter(group => group.kind !== 'folder' && group.kind !== 'unfiled')
    .map(group => group.id));
  const manual = new Set(book.manualFields ?? []);
  const folderGroups = (book.groups ?? []).filter(group => group.kind === 'folder');
  const toggle = (id: string) => setSelected(current => (current.includes(id)
    ? current.filter(value => value !== id)
    : [...current, id]));

  const level1 = useMemo(() => topLevelGroups(groups), [groups]);
  /** Which 大类 the sheet is showing; a book may still belong to several. */
  const [activeRootId, setActiveRootId] = useState<string | null>(() => {
    for (const ref of book.groups ?? []) {
      if (ref.kind === 'folder' || ref.kind === 'unfiled') continue;
      const root = groupRootOf(groups, ref.id);
      if (root) return root.id;
    }
    return null;
  });
  /** Tags whose 四级 children are unfolded; a chosen 四级 opens its tag on load. */
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const open = new Set<string>();
    for (const ref of book.groups ?? []) {
      const group = groups.find(entry => entry.id === ref.id);
      if (group && group.level === 4 && group.parentId) open.add(group.parentId);
    }
    return open;
  });
  const toggleExpanded = (id: string) => setExpanded(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const activeRoot = level1.find(group => group.id === activeRootId) ?? level1[0];
  const blocks = activeRoot
    ? groupBlocksUnder(groups, activeRoot.id)
    : { second: [], third: [], fourth: [] };

  return <Sheet
    title={book.title || '书籍详情'}
    subtitle={book.author || '作者未知'}
    busy={busy}
    onClose={onClose}
    footer={<>
      <Link className="button" to={`/book/${encodeURIComponent(book.id)}`}>开始阅读</Link>
      <button type="button" className="button primary" disabled={busy} onClick={() => onSave({
        title: title.trim(), author: author.trim(), description: description.trim(), series: series.trim(),
        seriesIndex: index.trim() === '' ? null : Number(index),
      }, selected)}>保存</button>
    </>}
  >
    <div className="sheet-form">
      {error && <Callout tone="error">{error}</Callout>}

      <div className="sheet-field">
        <label htmlFor="book-detail-title">书名</label>
        <input id="book-detail-title" type="text" value={title} disabled={busy}
          onChange={event => setTitle(event.currentTarget.value)} placeholder="书名" />
        {manual.has('title') && <button type="button" className="button" disabled={busy}
          onClick={() => onClearField('title')}>撤销手改（恢复文件里的书名）</button>}
      </div>

      <div className="sheet-field">
        <label htmlFor="book-detail-author">作者</label>
        <input id="book-detail-author" type="text" value={author} disabled={busy}
          onChange={event => setAuthor(event.currentTarget.value)} placeholder="作者" />
        {manual.has('author') && <button type="button" className="button" disabled={busy}
          onClick={() => onClearField('author')}>撤销手改（恢复文件里的作者）</button>}
      </div>

      <div className="sheet-field">
        <label htmlFor="book-detail-description">简介</label>
        <textarea id="book-detail-description" rows={5} value={description} disabled={busy}
          onChange={event => setDescription(event.currentTarget.value)} placeholder="还没有简介" />
        {manual.has('description') && <button type="button" className="button" disabled={busy}
          onClick={() => onClearField('description')}>撤销手改（恢复文件里的简介）</button>}
      </div>

      <div className="sheet-field">
        <label>分组<span className="muted">（可多选；点名字换一个类看，点 ＋ 直接归到这个类）</span></label>
        {groups.length === 0
          ? <p className="sheet-text muted">还没有分组。</p>
          : <>
            <div className="chip-row" role="group" aria-label="一级分组">
              {level1.map(group => {
                const chosen = selected.includes(group.id);
                return <span key={group.id} className="chip-split">
                  <button type="button" className="chip-split-main" aria-pressed={activeRoot?.id === group.id}
                    aria-label={`查看「${group.name}」下的分组`}
                    onClick={() => setActiveRootId(group.id)}>{group.name}</button>
                  <button type="button" className="chip-split-tail" aria-pressed={chosen}
                    aria-label={chosen ? `把书从「${group.name}」移出` : `把书放进「${group.name}」`}
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
          </>}
      </div>

      {folderGroups.length > 0 && <div className="sheet-field">
        <label>文件夹分组<span className="muted">（按文件所在目录自动生成，不可修改）</span></label>
        <p className="sheet-text">{folderGroups.map(group => groupPathLabel(group.name)).join('、')}</p>
      </div>}

      <div className="sheet-field">
        <label htmlFor="book-detail-series">丛书（文件内嵌）<span className="muted">（留空表示没有丛书）</span></label>
        <input id="book-detail-series" type="text" value={series} disabled={busy}
          onChange={event => setSeries(event.currentTarget.value)} placeholder="例如：三体" />
        {manual.has('series') && <button type="button" className="button" disabled={busy}
          onClick={() => onClearField('series')}>撤销手改（恢复文件里的丛书）</button>}
      </div>

      <div className="sheet-field">
        <label htmlFor="book-detail-index">丛书编号</label>
        <input id="book-detail-index" type="number" inputMode="numeric" value={index} disabled={busy}
          onChange={event => setIndex(event.currentTarget.value)} placeholder="1" />
      </div>

      <dl className="book-detail">
        <div><dt>格式</dt><dd>{book.format || '—'}</dd></div>
        <div><dt>大小</dt><dd>{formatSize(book.fileSize)}</dd></div>
        {book.pageCount != null && <div><dt>页数</dt><dd>{book.pageCount}</dd></div>}
        {book.addedAt != null && <div><dt>入库</dt><dd>{new Date(book.addedAt).toLocaleDateString()}</dd></div>}
        <div><dt>来源</dt><dd>{book.source || '本地'}</dd></div>
      </dl>
    </div>
  </Sheet>;
}
