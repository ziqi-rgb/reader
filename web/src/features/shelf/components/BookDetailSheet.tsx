import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Sheet } from '../../../ui/sheet.tsx';
import { Callout } from '../../../ui/toolkit.tsx';
import type { Book, BookGroup } from '../../../api/types.ts';

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
 * Every field the reader has overridden by hand (`book.manualFields`) offers 撤销手改,
 * which falls back to whatever the file carries — that is the only way back once a
 * rescan has been overruled.
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
  const [selected, setSelected] = useState<string[]>(() => (book.groups ?? []).map(group => group.id));
  const manual = new Set(book.manualFields ?? []);
  const toggle = (id: string) => setSelected(current => (current.includes(id)
    ? current.filter(value => value !== id)
    : [...current, id]));

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
        <label>分组<span className="muted">（可多选；和文件里的系列、标签无关）</span></label>
        {groups.length === 0
          ? <p className="sheet-text muted">还没有分组。</p>
          : <div className="shelf-status" role="group" aria-label="选择分组">
            {groups.map(group => <button key={group.id} type="button" className="chip" aria-pressed={selected.includes(group.id)}
              aria-label={`${group.name}，${group.bookCount} 本`}
              disabled={busy} onClick={() => toggle(group.id)}>{group.name}</button>)}
          </div>}
      </div>

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
