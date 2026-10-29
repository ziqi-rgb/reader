import { useQueryClient } from '@tanstack/react-query';
import { coverTint } from '../../../ui/cover-tint.ts';
import { BookGridSkeleton } from '../../../ui/book-grid-skeleton.tsx';
import { Link, useSearchParams } from 'react-router-dom';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { BookOpen, LibraryBig, Search } from 'lucide-react';
import { Sheet } from '../../../ui/sheet.tsx';
import type { Book, ContinueReadingItem, ReadingState } from '../../../api/types.ts';
import { useRuntime } from '../../../app/providers/runtime-context.tsx';
import { useSettingsStore } from '../../../shared/stores/settings.store.ts';
import { useShelf, useShelfGroups, type ShelfFilters } from '../queries/shelf.queries.ts';
import { SHELF_SORTS, ShelfSettingsSheet } from '../../../ui/shelf-settings.tsx';
import { IconButton, Callout } from '../../../ui/toolkit.tsx';
import { OpdsAccess } from '../../../ui/opds-access.tsx';
import { DialogView, type Dialog } from '../../../ui/dialog.tsx';
import { FloatingNotice } from '../../../ui/floating-notice.tsx';
import { useSwipeTabs } from '../../../shared/ui/use-swipe-tabs.ts';

const coverCache = new WeakMap<object, Map<string, string>>();

/**
 * Opens a card's menu from a right-click, or from a long press on a touch screen.
 *
 * The ⋯ glyph that used to sit on the cover is gone: it shared the cover's top
 * corner with the 丛书 stack badge and the reading-state chip, so on a stack card
 * it was the badge that took the taps, leaving the card's only menu unreachable.
 * The whole card is the target instead.
 */
function useCardMenu(onMenu?: () => void) {
  const timer = useRef<number | null>(null);
  const clear = () => { if (timer.current != null) { window.clearTimeout(timer.current); timer.current = null; } };
  useEffect(() => clear, []);
  if (!onMenu) return {};
  return {
    onContextMenu: (event: React.MouseEvent) => { event.preventDefault(); clear(); onMenu(); },
    onPointerDown: (event: React.PointerEvent) => {
      if (event.pointerType === 'mouse') return;
      clear();
      timer.current = window.setTimeout(() => { timer.current = null; onMenu(); }, 550);
    },
    onPointerUp: clear,
    onPointerLeave: clear,
    onPointerMove: clear,
    onPointerCancel: clear,
  };
}
export function useCover(api: ReturnType<typeof useRuntime>['api'], coverUrl: string | null | undefined): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!coverUrl) { setSrc(null); return; }
    let cache = coverCache.get(api) as Map<string, string> | undefined;
    if (!cache) { cache = new Map(); coverCache.set(api, cache); }
    const cached = cache.get(coverUrl);
    if (cached) { setSrc(cached); return; }
    let live = true;
    void api.coverBytes(coverUrl).then(bytes => {
      const objectUrl = URL.createObjectURL(new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: 'image/jpeg' }));
      cache!.set(coverUrl, objectUrl); if (live) setSrc(objectUrl);
    }).catch(() => { if (live) setSrc(null); });
    return () => { live = false; };
  }, [api, coverUrl]);
  return src;
}

export function BookCard({ book, showAuthor, showProgress, onRemove, selecting, selected, onToggle }: { book: Book | ContinueReadingItem; showAuthor: boolean; showProgress: boolean; onRemove?: () => void; selecting?: boolean; selected?: boolean; onToggle?: () => void }) {
  const runtime = useRuntime();
  const src = useCover(runtime.api, book.coverUrl);
  const progress = 'percentage' in book ? book.percentage : runtime.offline?.progressFor(book.id)?.percentage;
  const selectedCls = selecting && selected ? ' is-selected' : '';
  const menu = useCardMenu(selecting ? undefined : onRemove);
  return <div className={"book-card" + selectedCls} {...menu} onClick={selecting ? onToggle : undefined} role={selecting ? "button" : undefined} tabIndex={selecting ? 0 : undefined} aria-pressed={selecting ? selected : undefined}
    onKeyDown={selecting ? (event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggle?.(); } }) : undefined}>
    {selecting
      ? <div className="book-open" aria-hidden="true">
        <div className="cover">
          {src ? <img src={src} alt="" loading="lazy" /> : <div className="placeholder" style={coverTint(book.title || '')}>{book.title || '无封面'}</div>}
          <span className="format-badge">{book.format || '书籍'}</span>
          <span className="select-check" aria-hidden="true">✓</span>
        </div>
        <div className="title">{book.title || '未命名'}</div>
        {showAuthor && <div className="author">{book.author || '未知作者'}</div>}
      </div>
      : <Link className="book-open" aria-label={`${book.title} ${book.author ?? ''}`.trim()} to={`/book/${encodeURIComponent(book.id)}`}>
        <div className="cover">
          {src ? <img src={src} alt="" loading="lazy" /> : <div className="placeholder" style={coverTint(book.title || '')}>{book.title || '无封面'}</div>}
          <span className="format-badge">{book.format || '书籍'}</span>
          {showProgress && progress !== undefined && progress > 0 && <div className="cover-progress"><span style={{ width: `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%` }} /></div>}
        </div>
        <div className="title">{book.title || '未命名'}</div>
        {showAuthor && <div className="author">{book.author || '未知作者'}</div>}
      </Link>}
    {'readingState' in book && book.readingState && <span className="book-state" data-state={book.readingState}>{readingLabels[book.readingState]}</span>}
  </div>;
}

const readingLabels: Record<ReadingState, string> = { reading: '在读', want: '想读', finished: '已读' };
const readingStates = ['reading', 'want', 'finished'] as const;
const isReadingState = (value: string | null): value is ReadingState => readingStates.includes(value as ReadingState);
type BookAction = ReadingState | 'clear' | 'remove' | 'editSeries' | 'clearSeries';

/** A stack of same-series books collapsed into one shelf slot. */
function SeriesCover({ url, fallback }: { url: string | null; fallback: string }) {
  const runtime = useRuntime();
  const src = useCover(runtime.api, url);
  return src ? <img src={src} alt="" loading="lazy" /> : <div className="placeholder" style={coverTint(fallback)}>{fallback || '无封面'}</div>;
}

/** A stack of same-series books collapsed into one shelf slot. */
export function SeriesCard({ books, showAuthor, onRemove }: { books: Book[]; showAuthor: boolean; onRemove?: (books: Book[]) => void }) {
  const [expanded, setExpanded] = useState(false);
  const first = books[0];
  // The volume the reader is actually in: marked 在读 wins, else the most
  // recently touched one. Tapping the card opens *that* volume, not the first,
  // so "continue the 丛书" means continuing where they left off.
  const current = books.find(book => book.readingState === 'reading')
    ?? [...books].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
    ?? first;
  const progressLabel = current.seriesIndex != null ? `第 ${current.seriesIndex} 册 · ${current.title || '未命名'}` : current.title || '未命名';
  const menu = useCardMenu(onRemove ? () => onRemove(books) : undefined);
  return <div className="book-card series-card" data-count={books.length} data-expanded={String(expanded)} {...menu}>
    <button type="button" className="series-toggle" onClick={() => setExpanded(v => !v)} aria-expanded={expanded} aria-label={`展开 ${first.series}（${books.length} 册）`}>
      <span className="series-badge">📚 {books.length}</span>
    </button>
    <Link className="book-open" aria-label={`${first.series} ${progressLabel}`.trim()} to={`/book/${encodeURIComponent(current.id)}`}>
      <div className="cover">
        <SeriesCover url={first.coverUrl} fallback={first.series || '丛书'} />
        <span className="format-badge">{books.length} 册</span>
      </div>
      <div className="title">{first.series || '未命名丛书'}</div>
      <div className="series-current">{progressLabel}</div>
      {showAuthor && <div className="author">{first.author || '未知作者'}</div>}
    </Link>
    {expanded && <div className="series-list">{books.map(book => <div key={book.id} className="series-item" data-current={book.id === current.id ? 'true' : undefined}><span className="series-item-num">{book.seriesIndex ?? '·'}</span><Link to={`/book/${encodeURIComponent(book.id)}`}>{book.title || '未命名'}</Link>{'readingState' in book && book.readingState && <span className="book-state" data-state={book.readingState}>{readingLabels[book.readingState]}</span>}</div>)}</div>}
  </div>;
}

export function ShelfPage() {
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  const settings = useSettingsStore(state => state.settings);
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [sort, setSort] = useState<typeof settings.shelfSort>((params.get('sort') as typeof settings.shelfSort) || settings.shelfSort);
  const [search, setSearch] = useState(params.get('q') || '');
  const [queryText, setQueryText] = useState(params.get('q') || '');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [opdsOpen, setOpdsOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<Book | ContinueReadingItem | null>(null);
  /** The books the ⋯ menu acts on: one for a plain card, the whole run for a 丛书. */
  const [menuTarget, setMenuTarget] = useState<Book[] | null>(null);
  // Edit a book's 丛书名 + 编号; the value is a list of books (one for the single-card menu, many for batch tagging).
  const [editTarget, setEditTarget] = useState<Book[] | null>(null);
  const [editSeries, setEditSeries] = useState('');
  const [editIndex, setEditIndex] = useState('');
  // Multi-select mode for batch tagging a 丛书.
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [actionError, setActionError] = useState('');
  // 在读 / 想读 / 已读 and one 分组 (a series or a tag), all in the URL like the page and sort.
  const status = isReadingState(params.get('status')) ? params.get('status') as ReadingState : undefined;
  const series = params.get('series') || undefined, tag = series ? undefined : params.get('tag') || undefined;
  const filters: ShelfFilters = { ...(status ? { status } : {}), ...(series ? { series } : {}), ...(tag ? { tag } : {}) };
  const filtered = !!(status || series || tag);
  const groups = useShelfGroups(groupsOpen);
  const query = useShelf(page, sort, queryText, filters);
  const pages = query.data ? Math.max(1, Math.ceil(query.data.total / query.data.pageSize)) : 1;
  const cards = useMemo(() => query.data?.items ?? [], [query.data]);
  // Fold same-series books (≥2) into a single stacked card, keeping shelf order.
  const folded = useMemo(() => {
    const bySeries = new Map<string, Book[]>();
    for (const item of cards) {
      if ('series' in item && item.series) {
        const list = bySeries.get(item.series) ?? [];
        list.push(item);
        bySeries.set(item.series, list);
      }
    }
    const out: (Book | ContinueReadingItem | { series: Book[] })[] = [];
    const emitted = new Set<string>();
    for (const item of cards) {
      if ('series' in item && item.series && (bySeries.get(item.series)?.length ?? 0) > 1) {
        if (!emitted.has(item.series)) { out.push({ series: [...bySeries.get(item.series)!].sort((a, b) => (a.seriesIndex ?? 0) - (b.seriesIndex ?? 0)) }); emitted.add(item.series); }
      } else out.push(item);
    }
    return out;
  }, [cards]);
  useEffect(() => { void runtime.updateSettings({ shelfSort: sort }); }, [runtime, sort]);
  // Every navigation keeps what it does not change; a new filter or query starts at page 1.
  const go = (next: { q?: string; sort?: typeof sort; page?: number; status?: ReadingState | null; series?: string | null; tag?: string | null }) => {
    const q = next.q ?? queryText, nextStatus = next.status === undefined ? status : next.status ?? undefined;
    const nextSeries = next.series === undefined ? series : next.series ?? undefined, nextTag = next.tag === undefined ? tag : next.tag ?? undefined;
    setParams({ ...(q ? { q } : {}), sort: next.sort ?? sort, page: String(next.page ?? 1), ...(nextStatus ? { status: nextStatus } : {}), ...(nextSeries ? { series: nextSeries } : nextTag ? { tag: nextTag } : {}) });
  };
  const onSort = (value: string) => { const next = value as typeof sort; setSort(next); go({ sort: next }); };
  const onSearch = (event: FormEvent) => { event.preventDefault(); setQueryText(search.trim()); go({ q: search.trim() }); };
  const clearSearch = () => { setSearch(''); setQueryText(''); go({ q: '' }); };
  const clearFilters = () => go({ status: null, series: null, tag: null });
  // On a phone the status chips are also a swipe apart: 全部 · 在读 · 想读 · 已读.
  const swipe = useSwipeTabs<HTMLDivElement>(direction => {
    const order = [null, ...readingStates] as const;
    const next = order[order.indexOf(status ?? null) + (direction === 'next' ? 1 : -1)];
    if (next === undefined) return false;
    go({ status: next });
    return true;
  });
  const act = async (books: Book[], action: BookAction) => {
    const book = books[0];
    if (action === 'remove') { setRemoveTarget(book); return; }
    if (action === 'editSeries') {
      setEditTarget(books);
      setEditSeries(book.series ?? '');
      setEditIndex(books.length === 1 && book.seriesIndex != null ? String(book.seriesIndex) : '');
      return;
    }
    if (action === 'clearSeries') {
      // Clearing the label on one book would leave a 丛书 that is now a different
      // set; "取消丛书" has to mean every member.
      setActionError('');
      try {
        for (const member of books) await runtime.api.patchBookMetadata(member.id, { series: '', seriesIndex: null });
        await queryClient.invalidateQueries({ queryKey: ['shelf'] });
      } catch (error) { setActionError(error instanceof Error ? error.message : '取消丛书失败，请稍后重试。'); }
      return;
    }
    setActionError('');
    try {
      await runtime.api.setReadingStatus(book.id, action === 'clear' ? null : action);
      await queryClient.invalidateQueries({ queryKey: ['shelf'] });
    } catch (error) { setActionError(error instanceof Error ? error.message : '标记失败，请稍后重试。'); }
  };
  const menuOptions = (books: Book[]) => {
    // A 丛书 is edited and cleared as a set: the card represents all of them.
    if (books.length > 1) return [
      { value: 'editSeries', label: `编辑整组丛书（${books.length} 册）` },
      { value: 'clearSeries', label: '取消丛书（整组）' },
    ];
    const book = books[0];
    return [
      ...readingStates.filter(state => state !== book.readingState).map(state => ({ value: state, label: '标记为' + readingLabels[state] })),
      ...(book.readingState ? [{ value: 'clear', label: '清除标记' }] : []),
      { value: 'editSeries', label: '编辑丛书 / 编号' },
      ...(book.series ? [{ value: 'clearSeries', label: '取消丛书' }] : []),
      { value: 'remove', label: '从书架拿掉' },
    ];
  };
  const saveEditSeries = async () => {
    if (!editTarget) return;
    setActionError('');
    try {
      for (let i = 0; i < editTarget.length; i++) {
        const book = editTarget[i];
        // Send the blank string and a null index rather than dropping them: the
        // server treats an empty override as the reader's explicit "no 丛书",
        // and omitting the field would leave the old value in place.
        const idx = editTarget.length === 1 ? (editIndex === '' ? null : Number(editIndex)) : (Number(editIndex) || 1) + i;
        await runtime.api.patchBookMetadata(book.id, { series: editSeries.trim(), seriesIndex: idx });
      }
      setEditTarget(null);
      await queryClient.invalidateQueries({ queryKey: ['shelf'] });
    } catch (error) { setActionError(error instanceof Error ? error.message : '保存失败，请稍后重试。'); }
  };
  const groupOptions = [
    { value: '', label: '全部书籍' },
    ...(groups.data?.series ?? []).map(value => ({ value: 'series:' + value, label: '系列 · ' + value })),
    ...(groups.data?.tags ?? []).map(value => ({ value: 'tag:' + value, label: '标签 · ' + value })),
  ];
  // Batch-tag entry: toggle a card's books in/out of the selection, then open the 丛书 editor.
  const toggleSelect = (entry: Book | { series: Book[] }) => {
    const ids = 'id' in entry ? [entry.id] : entry.series.map(b => b.id);
    const next = new Set(selected);
    const allSelected = ids.every(id => selected.has(id));
    if (allSelected) ids.forEach(id => next.delete(id));
    else ids.forEach(id => next.add(id));
    setSelected(next);
  };
  const startBatchEdit = () => {
    const books = cards.filter(b => 'id' in b && selected.has((b as Book).id)) as Book[];
    if (books.length === 0) { setActionError('请先选中要标记的书。'); return; }
    setSelectMode(false);
    setEditTarget(books);
    setEditSeries('');
    setEditIndex('1');
  };
  const groupLabel = series ? '系列 · ' + series : tag ? '标签 · ' + tag : '';
  const remove = async (book: Book | ContinueReadingItem) => { await runtime.api.browseBatchShelf({ bookIds: [book.id] }, 'remove'); await queryClient.invalidateQueries({ queryKey: ['shelf'] }); };
  const subtitle = queryText ? (query.data?.total ? `「${queryText}」匹配 ${query.data.total} 本` : `没有匹配「${queryText}」的书`) : '收藏好书，随时接着读'; // count and sort live in the sticky toolbar below; saying them twice is noise
  const densityLabel = settings.shelfDensity === 'compact' ? '紧凑' : settings.shelfDensity === 'comfortable' ? '宽松' : '适中';
  return <div ref={swipe} id="shelf-scroll" className="shelf shelf-screen">
    <header className="shelf-head">
      <div className="shelf-head-text"><h1 className="shelf-title">{queryText ? '筛选结果' : '书架'}</h1><p className="shelf-subtitle muted">{subtitle}</p></div>
      <div className="shelf-head-actions">
        <IconButton icon="tune" label={`书架设置 · ${densityLabel}`} onClick={() => setSettingsOpen(true)} />
      </div>
    </header>
    <div className="shelf-discovery">
      <nav className="collection-links shelf-links" aria-label="发现书籍">
        <Link className="button collection-link" to="/library"><LibraryBig size={18} /><span>书库</span><span aria-hidden="true">›</span></Link>
        <Link className="button collection-link" to="/sources"><Search size={18} /><span>书源</span><span aria-hidden="true">›</span></Link>
      </nav>
      <form className="shelf-search" role="search" onSubmit={onSearch}>
        <Search className="search-glyph" size={18} aria-hidden="true" />
        <input type="search" aria-label="筛选书架" placeholder="在书架中筛选书名、作者、系列" value={search} onChange={event => setSearch(event.currentTarget.value)} />
        {search && <button type="button" className="search-clear" aria-label="清除搜索" onClick={clearSearch}>×</button>}
      </form>
    </div>
    <section className="shelf-section" aria-label={queryText ? '筛选结果' : '全部书籍'}>
      <div className="shelf-filters">
        <div className="shelf-status" role="group" aria-label="阅读状态">
          <button type="button" className="chip" aria-pressed={!status} onClick={() => go({ status: null })}>全部</button>
          {readingStates.map(state => <button key={state} type="button" className="chip" aria-pressed={status === state} onClick={() => go({ status: state })}>{readingLabels[state]}</button>)}
        </div>
        {groupLabel
          ? <button type="button" className="chip shelf-group-active" aria-pressed="true" aria-label={`${groupLabel}，点按取消分组`} onClick={() => go({ series: null, tag: null })}>{groupLabel}<span aria-hidden="true"> ×</span></button>
          : <button type="button" className="chip shelf-group" aria-haspopup="dialog" onClick={() => setGroupsOpen(true)}>分组</button>}
      </div>
      <FloatingNotice message={actionError} error />
      {(!query.isPending && (cards.length > 0 || queryText || filtered)) && <div className="shelf-toolbar"><span className="shelf-count muted">{queryText ? `找到 ${query.data?.total ?? 0} 本` : `共 ${query.data?.total ?? 0} 本`}</span><div className="shelf-sort" role="group" aria-label="排序方式">{SHELF_SORTS.map(option => <button key={option.value} type="button" className="chip" aria-pressed={option.value === sort} onClick={() => onSort(option.value)}>{option.label}</button>)}</div><button type="button" className="chip" aria-pressed={selectMode} onClick={() => { setSelectMode(v => !v); if (selectMode) setSelected(new Set()); }}>{selectMode ? '取消选择' : '批量标记'}</button></div>}
      {query.isPending && <><FloatingNotice message="正在加载书架…" busy /><BookGridSkeleton density={settings.shelfDensity} /></>}
      {query.error && <Callout tone="error" title="书架加载失败">{query.error.message}</Callout>}
      {query.data && cards.length === 0 && filtered && !queryText && <div className="empty-state collection-empty"><BookOpen className="empty-glyph" aria-hidden="true" /><p>{status ? `还没有${readingLabels[status]}的书` : '这个分组里没有书'}</p><p className="muted">{status === 'want' ? '在书籍的“⋯”菜单里可以标记想读。' : '换一个分类，或查看全部书籍。'}</p><div className="empty-actions"><button type="button" className="button" onClick={clearFilters}>查看全部书籍</button></div></div>}
      {query.data && cards.length === 0 && !(filtered && !queryText) && <div className="empty-state collection-empty"><BookOpen className="empty-glyph" aria-hidden="true" /><p>{queryText ? '没有匹配的书' : '书架还没有书'}</p><p className="muted">{queryText ? '换个关键词，或者检查一下作者名的写法' : '从书库挑选喜欢的书，或通过书源搜索，加入书架后就能开始阅读。'}</p><div className="empty-actions">{queryText ? <button type="button" className="button" onClick={clearSearch}>清除搜索</button> : <><Link className="button primary" to="/sources"><Search size={16} />去搜书</Link><Link className="button" to="/library"><LibraryBig size={16} />打开书库</Link></>}</div></div>}
      {selectMode && <div className="shelf-batch-bar"><button type="button" className="chip" onClick={() => { const all = cards.map(b => (b as Book).id); const allSel = all.length > 0 && all.every(id => selected.has(id)); setSelected(allSel ? new Set() : new Set(all)); }}>{selected.size === cards.length && cards.length > 0 ? '取消全选' : '全选'}</button><span className="muted">已选 {selected.size}</span><button type="button" className="button primary" disabled={selected.size === 0} onClick={startBatchEdit}>标记为丛书</button></div>}
      {folded.length > 0 && <div className="book-grid" data-density={settings.shelfDensity} data-show-author={String(settings.shelfShowAuthor)} data-show-progress={String(settings.shelfShowProgress)} data-selecting={String(selectMode)}>{selectMode ? cards.map(book => <BookCard key={book.id} book={book as Book} showAuthor={settings.shelfShowAuthor} showProgress={settings.shelfShowProgress} selecting selected={selected.has((book as Book).id)} onToggle={() => toggleSelect(book)} />) : folded.map(entry => 'id' in entry ? <BookCard key={entry.id} book={entry as Book} showAuthor={settings.shelfShowAuthor} showProgress={settings.shelfShowProgress} onRemove={() => setMenuTarget([entry as Book])} /> : <SeriesCard key={'s:' + entry.series[0].series} books={entry.series} showAuthor={settings.shelfShowAuthor} onRemove={list => setMenuTarget(list)} />)}</div>}
      {query.data && pages > 1 && <nav className="shelf-pager" aria-label="翻页"><button type="button" disabled={page <= 1} onClick={() => go({ page: page - 1 })}>上一页</button><span>{page} / {pages}</span><button type="button" disabled={page >= pages} onClick={() => go({ page: page + 1 })}>下一页</button></nav>}
    </section>
    {settingsOpen && <ShelfSettingsSheet settings={settings} onPatch={patch => { void runtime.updateSettings(patch); }} onClose={() => setSettingsOpen(false)} onOpenExternalReader={() => { setSettingsOpen(false); setOpdsOpen(true); }} />}
    {opdsOpen && <OpdsAccess api={runtime.api} onSignedOut={() => { void runtime.api.signOut(); }} onClose={() => { setOpdsOpen(false); setSettingsOpen(true); }} />}
    {menuTarget && <DialogView dialog={{ kind: 'pick', title: menuTarget.length > 1 ? `${menuTarget[0].series || '丛书'}（${menuTarget.length} 册）` : `《${menuTarget[0].title || '未命名'}》`, options: menuOptions(menuTarget), resolve: (_value: string | null) => undefined } satisfies Dialog} destructive={menuTarget.length > 1 ? '' : '从书架拿掉'} onClose={answer => { const target = menuTarget; setMenuTarget(null); if (typeof answer === 'string' && answer) void act(target, answer as BookAction); }} />}
    {groupsOpen && <DialogView dialog={{ kind: 'pick', title: groups.isPending ? '分组 · 正在读取…' : groups.error ? '分组 · 读取失败' : '分组', options: groupOptions, resolve: (_value: string | null) => undefined } satisfies Dialog} destructive="" onClose={answer => {
      setGroupsOpen(false);
      if (typeof answer !== 'string') return;
      if (answer === '') go({ series: null, tag: null });
      else if (answer.startsWith('series:')) go({ series: answer.slice(7), tag: null });
      else if (answer.startsWith('tag:')) go({ tag: answer.slice(4), series: null });
    }} />}
    {removeTarget && <DialogView dialog={{ kind: 'confirm', title: '移出书架', body: `确定要将《${removeTarget.title}》移出书架吗？`, resolve: (_answer: boolean) => undefined } satisfies Dialog} destructive="移出书架" onClose={answer => { const target = removeTarget; setRemoveTarget(null); if (answer === true) void remove(target); }} />}
    {editTarget && <Sheet title={editTarget.length === 1 ? `编辑丛书 · 《${editTarget[0].title}》` : `批量标记丛书（${editTarget.length} 本）`} onClose={() => setEditTarget(null)} footer={<><button type="button" className="button" onClick={() => setEditTarget(null)}>取消</button><button type="button" className="button primary" onClick={() => void saveEditSeries()}>保存</button></>}><div className="sheet-form"><div className="sheet-field"><label htmlFor="series-name">丛书名</label><input id="series-name" type="text" value={editSeries} onChange={e => setEditSeries(e.currentTarget.value)} placeholder="例如：三体" /></div><div className="sheet-field"><label htmlFor="series-index">编号</label><input id="series-index" type="number" min="1" step="1" value={editIndex} onChange={e => setEditIndex(e.currentTarget.value)} placeholder={editTarget.length > 1 ? '起始编号（自动递增）' : '例如：1'} /></div>{editTarget.length > 1 && <p className="sheet-text">将从第 {Number(editIndex) || 1} 号开始，按当前顺序递增分配。</p>}</div></Sheet>}
  </div>;
}
