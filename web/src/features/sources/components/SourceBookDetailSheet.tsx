import type { SourceEntry } from '../../../api/sources.ts';
import { Link } from 'react-router-dom';
import { Sheet } from '../../../ui/sheet.tsx';
import { Button } from '../../../ui/toolkit.tsx';
import { FloatingNotice } from '../../../ui/floating-notice.tsx';

/**
 * A source result's detail, shared by the source hub and a single source's catalog:
 * they show the same entry and offer the same 加入书架 choices.
 *
 * An entry that is already on the shelf offers 去阅读 instead: adding it again is
 * idempotent on the server, but a button that says 加入书架 for a book the reader
 * already has reads as "you will get a second copy".
 */
export function SourceBookDetailSheet({ detail, pending, error, acquiring, onAcquire, onClose }: {
  detail: SourceEntry;
  pending: boolean;
  error: Error | null;
  acquiring: boolean;
  onAcquire(entry: SourceEntry, option?: string): void;
  onClose(): void;
}) {
  const options = detail.options ?? [];
  const owned = detail.bookId;
  return <Sheet title={detail.title || '书籍详情'} onClose={onClose}
    footer={owned
      ? <Link className="button primary" to={`/book/${encodeURIComponent(owned)}`}>去阅读</Link>
      : options.length
        ? options.map(option => <Button key={option.id} className="primary" disabled={option.available === false || acquiring} onClick={() => onAcquire(detail, option.id)}>{option.label}</Button>)
        : <Button className="primary" disabled={acquiring} onClick={() => onAcquire(detail)}>加入书架</Button>}>
    <FloatingNotice message={pending ? '正在读取书籍详情…' : ''} busy />
    <div className="book-detail">
      {owned && <p className="catalog-owned">已在书架</p>}
      <p className="book-detail-author">{detail.authors?.join('、') || '作者未知'}</p>
      {error && <p className="notice error" role="alert">{error.message}</p>}
      <p className="book-detail-description">{detail.description || '暂无简介'}</p>
    </div>
  </Sheet>;
}
