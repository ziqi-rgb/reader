import { useQuery, useQueryClient } from '@tanstack/react-query';
import { coverTint } from '../../../ui/cover-tint.ts';
import { BookGridSkeleton } from '../../../ui/book-grid-skeleton.tsx';
import { Link, useSearchParams } from 'react-router-dom';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { BookOpen, LibraryBig, Search } from 'lucide-react';
import { Sheet } from '../../../ui/sheet.tsx';
import type { Book, BookGroup, ContinueReadingItem, GroupMode, ReadingState } from '../../../api/types.ts';
import { useRuntime } from '../../../app/providers/runtime-context.tsx';
import { useSettingsStore } from '../../../shared/stores/settings.store.ts';
import { useShelf, useBookGroups, type ShelfFilters } from '../queries/shelf.queries.ts';
import { foldSeries } from '../series.ts';
import { defaultGroup, groupFilterIds, groupFilterValue, isManualGroup, subGroupValuesOf, activeTopGroupOf, type GroupModes } from '../groups.ts';
import { BookDetailSheet, type BookMetadataDraft } from '../components/BookDetailSheet.tsx';
import { GroupFilterBar, GroupFilterSheet } from '../components/group-filter.tsx';
import { SHELF_SORTS, ShelfSettingsSheet } from '../../../ui/shelf-settings.tsx';
import { IconButton, Callout } from '../../../ui/toolkit.tsx';
import { OpdsAccess } from '../../../ui/opds-access.tsx';
import { DialogView, type Dialog } from '../../../ui/dialog.tsx';
import { FloatingNotice } from '../../../ui/floating-notice.tsx';
import { useSwipeTabs } from '../../../shared/ui/use-swipe-tabs.ts';
import { ServerCacheBadge, type CacheProgress } from '../components/server-cache-badge.tsx';

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

export function BookCard({ book, showAuthor, showProgress, onRemove, selecting, selected, onToggle, cache }: { book: Book | ContinueReadingItem; showAuthor: boolean; showProgress: boolean; onRemove?: () => void; selecting?: boolean; selected?: boolean; onToggle?: () => void; cache?: CacheProgress | undefined }) {
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
    {/* Its own layer on the card, not a slot inside the cover: the cover already
        carries the format badge (bottom-right) and the progress bar (bottom edge). */}
    {cache && <ServerCacheBadge progress={cache} />}
    {'readingState' in book && book.readingState && <span className="book-state" data-state={book.readingState}>{readingLabels[book.readingState]}</span>}
  </div>;
}

const readingLabels: Record<ReadingState, string> = { reading: '在读', want: '想读', finished: '已读' };
const readingStates = ['reading', 'want', 'finished'] as const;
const isReadingState = (value: string | null): value is ReadingState => readingStates.includes(value as ReadingState);

/**
 * The badge's numbers for one book, or nothing.
 *
 * Only a source novel has a server-side chapter cache; a local EPUB/PDF/CBZ is a
 * file that is already on the server, so "downloaded?" has no answer to draw.
 */
export function cacheProgressOf(book: Book, cache: ReadonlyMap<string, number>): CacheProgress | undefined {
  if (book.format !== 'chapters') return undefined;
  const total = book.pageCount ?? 0;
  if (total <= 0) return undefined;
  return { cached: Math.min(cache.get(book.id) ?? 0, total), total };
}

/** A 丛书 in the same terms: everything its volumes have cached together. */
export function seriesCacheProgress(books: readonly Book[], cache: ReadonlyMap<string, number>): CacheProgress | undefined {
  let cached = 0, total = 0;
  for (const book of books) {
    const progress = cacheProgressOf(book, cache);
    if (!progress) continue;
    cached += progress.cached;
    total += progress.total;
  }
  return total > 0 ? { cached, total } : undefined;
}
type BookAction = ReadingState | 'clear' | 'remove' | 'editSeries' | 'clearSeries' | 'detail' | 'seriesDetail';

/** A stack of same-series books collapsed into one shelf slot. */
function SeriesCover({ url, fallback }: { url: string | null; fallback: string }) {
  const runtime = useRuntime();
  const src = useCover(runtime.api, url);
  return src ? <img src={src} alt="" loading="lazy" /> : <div className="placeholder" style={coverTint(fallback)}>{fallback || '无封面'}</div>;
}

/** A stack of same-series books collapsed into one shelf slot. */
export function SeriesCard({ books, showAuthor, onRemove, expandable = true, cache }: { books: Book[]; showAuthor: boolean; onRemove?: (books: Book[]) => void; expandable?: boolean; cache?: CacheProgress | undefined }) {
  const [expanded, setExpanded] = useState(false);
  const first = books[0];
  // The volume the reader is actually in: most recently read wins, then the 在读
  // mark, then the file's own timestamp.
  //
  // `find(readingState === 'reading')` used to decide this, which in a 丛书 where
  // several volumes are marked 在读 simply returned the first one — so opening
  // volume 2, quitting and refreshing still showed volume 1. Only
  // `lastReadAt` (reading_progress.updated_at) records a reading session;
  // `updatedAt` is the file's and a session never touches it.
  const readTime = (book: Book) => book.lastReadAt ?? 0;
  const current = [...books].sort((a, b) => {
    const byRead = readTime(b) - readTime(a);
    if (byRead !== 0) return byRead;
    const byMark = Number(b.readingState === 'reading') - Number(a.readingState === 'reading');
    if (byMark !== 0) return byMark;
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  })[0] ?? first;
  const progressLabel = current.seriesIndex != null ? `第 ${current.seriesIndex} 册 · ${current.title || '未命名'}` : current.title || '未命名';
  const menu = useCardMenu(onRemove ? () => onRemove(books) : undefined);
  return <div className="book-card series-card" data-count={books.length} data-expanded={String(expandable && expanded)} {...menu}>
    {expandable && <button type="button" className="series-toggle" onClick={() => setExpanded(v => !v)} aria-expanded={expanded} aria-label={`展开 ${first.series}（${books.length} 册）`}>
      <span className="series-badge">📚 {books.length}</span>
    </button>}
    <Link className="book-open" aria-label={`${first.series} ${progressLabel}`.trim()} to={`/book/${encodeURIComponent(current.id)}`}>
      <div className="cover">
        <SeriesCover url={first.coverUrl} fallback={first.series || '丛书'} />
        <span className="format-badge">{books.length} 册</span>
      </div>
      <div className="title">{first.series || '未命名丛书'}</div>
      <div className="series-current">{progressLabel}</div>
      {showAuthor && <div className="author">{first.author || '未知作者'}</div>}
    </Link>
    {cache && <ServerCacheBadge progress={cache} />}
    {expandable && expanded && <div className="series-list">{books.map(book => <div key={book.id} className="series-item" data-current={book.id === current.id ? 'true' : undefined}><span className="series-item-lead"><span className="series-item-num">{book.seriesIndex ?? '·'}</span>{'readingState' in book && book.readingState && <span className="book-state" data-state={book.readingState}>{readingLabels[book.readingState]}</span>}</span><Link to={`/book/${encodeURIComponent(book.id)}`}>{book.title || '未命名'}</Link></div>)}</div>}
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
  /**
   * `batch` labels a set of loose books; `manage` reorders and prunes an existing
   * 丛书. Same dialog slot, different question: "which books join" versus "what
   * order are these in, and is this one still part of it".
   */
  const [editMode, setEditMode] = useState<'batch' | 'manage'>('batch');
  const [editOrder, setEditOrder] = useState<Book[]>([]);
  const [editRemoved, setEditRemoved] = useState<Book[]>([]);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  // Multi-select mode for batch tagging a 丛书.
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [actionError, setActionError] = useState('');
  /** The book whose 书籍详情 sheet is open, plus that sheet's own write state. */
  const [detailTarget, setDetailTarget] = useState<Book | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState('');
  /** A whole 丛书 stack being filed into groups (same groups for every volume). */
  const [seriesTarget, setSeriesTarget] = useState<Book[] | null>(null);
  const [seriesTargetIds, setSeriesTargetIds] = useState<string[]>([]);
  const [seriesTargetBusy, setSeriesTargetBusy] = useState(false);
  const [seriesTargetError, setSeriesTargetError] = useState('');
  // 在读 / 想读 / 已读 and the reader's own groups (或 / 与 / 非), all in the URL like the page and sort.
  const status = isReadingState(params.get('status')) ? params.get('status') as ReadingState : undefined;
  const groupIds = (params.get('groups') ?? '').split(',').map(value => value.trim()).filter(Boolean);
  const readMode = (value: string | null): GroupMode => (value === 'and' ? 'and' : value === 'not' ? 'not' : 'or');
  // Each level has its own 或 / 与 / 非; `groupMode` is the one-mode form older URLs carry.
  const groupModes: GroupModes = {
    2: readMode(params.get('groupMode2') ?? params.get('groupMode')),
    3: readMode(params.get('groupMode3') ?? params.get('groupMode')),
    4: readMode(params.get('groupMode4') ?? params.get('groupMode')),
  };
  const filters: ShelfFilters = { ...(status ? { status } : {}), ...(groupIds.length > 0 ? { groups: groupIds, groupModes } : {}) };
  const filtered = !!(status || groupIds.length > 0);
  const groups = useBookGroups();
  const query = useShelf(page, sort, queryText, filters);
  const pages = query.data ? Math.max(1, Math.ceil(query.data.total / query.data.pageSize)) : 1;
  const cards = useMemo(() => query.data?.items ?? [], [query.data]);
  // Same-series books (≥2) share one slot; `foldSeries` is shared with the home rail.
  const folded = useMemo(() => foldSeries(cards), [cards]);
  /**
   * Server-side chapter cache for the whole shelf, in one request.
   *
   * Only the *server* copy: the browser's session cache dies with the browser,
   * so drawing it here would promise something the reader cannot rely on.
   */
  const cacheSummary = useQuery({
    queryKey: ['chapter-cache-summary', runtime.api.baseUrl],
    queryFn: () => runtime.api.chapterCacheSummary(),
    staleTime: 15_000,
  });
  const serverCache = useMemo(
    () => new Map((cacheSummary.data?.books ?? []).map(entry => [entry.bookId, entry.chapters] as const)),
    [cacheSummary.data],
  );
  useEffect(() => { void runtime.updateSettings({ shelfSort: sort }); }, [runtime, sort]);
  // Every navigation keeps what it does not change; a new filter or query starts at page 1.
  const go = (next: { q?: string; sort?: typeof sort; page?: number; status?: ReadingState | null; groups?: string[] | null; groupModes?: GroupModes }) => {
    const q = next.q ?? queryText, nextStatus = next.status === undefined ? status : next.status ?? undefined;
    const nextGroups = next.groups === undefined ? groupIds : next.groups ?? [];
    const nextModes = next.groupModes ?? groupModes;
    setParams({
      ...(q ? { q } : {}), sort: next.sort ?? sort, page: String(next.page ?? 1),
      ...(nextStatus ? { status: nextStatus } : {}),
      // 或 is the default for every level; anything else has to be said per level.
      ...(nextGroups.length > 0
        ? {
          groups: nextGroups.join(','),
          ...(nextModes[2] !== 'or' ? { groupMode2: nextModes[2] } : {}),
          ...(nextModes[3] !== 'or' ? { groupMode3: nextModes[3] } : {}),
          ...(nextModes[4] !== 'or' ? { groupMode4: nextModes[4] } : {}),
        }
        : {}),
    });
  };
  const onSort = (value: string) => { const next = value as typeof sort; setSort(next); go({ sort: next }); };
  const onSearch = (event: FormEvent) => { event.preventDefault(); setQueryText(search.trim()); go({ q: search.trim() }); };
  const clearSearch = () => { setSearch(''); setQueryText(''); go({ q: '' }); };
  const clearFilters = () => go({ status: null, groups: null });
  // On a phone the status chips are also a swipe apart: 全部 · 在读 · 想读 · 已读.
  const swipe = useSwipeTabs<HTMLDivElement>(direction => {
    const order = [null, ...readingStates] as const;
    const next = order[order.indexOf(status ?? null) + (direction === 'next' ? 1 : -1)];
    if (next === undefined) return false;
    go({ status: next });
    return true;
  });
  /**
   * Refreshes everything an edit can change.
   *
   * `['shelf']` alone is not enough: the 分组 picker reads `['book-groups']` and the
   * home rail reads `['home']`, and neither key starts with `shelf`, so the prefix
   * match skips them — the rows would update while the group list and the "continue
   * reading" strip kept the old values.
   */
  const refreshShelf = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['shelf'] }),
      queryClient.invalidateQueries({ queryKey: ['book-groups'] }),
      queryClient.invalidateQueries({ queryKey: ['home'] }),
    ]);
  };

  const act = async (books: Book[], action: BookAction) => {
    const book = books[0];
    if (action === 'remove') { setRemoveTarget(book); return; }
    if (action === 'detail') {
      // 书籍详情 / 编辑: the shelf's own view of this book (书名 / 作者 / 分组 / 丛书).
      setDetailTarget(book);
      setDetailError('');
      return;
    }
    if (action === 'seriesDetail') {
      // A 丛书 stack is filed as one set: every volume gets the same groups.
      setSeriesTarget(books);
      // Start from the groups all volumes already share, so re-saving is a no-op.
      // Folder groups are read-only, so they never become part of the selection.
      const shared = (book.groups ?? []).filter(group => group.kind !== 'folder').map(group => group.id)
        .filter(id => books.every(item => (item.groups ?? []).some(group => group.id === id)));
      setSeriesTargetIds(shared);
      setSeriesTargetError('');
      return;
    }
    if (action === 'editSeries') {
      setEditTarget(books);
      setEditSeries(book.series ?? '');
      setEditRemoved([]);
      if (books.length > 1) {
        // An existing 丛书: the useful questions are "what order" and "is this
        // one still in it", not "which books are joining".
        setEditMode('manage');
        setEditOrder([...books].sort((a, b) => (a.seriesIndex ?? 0) - (b.seriesIndex ?? 0)));
        setEditIndex('');
      } else {
        setEditMode('batch');
        setEditOrder([]);
        setEditIndex(book.seriesIndex != null ? String(book.seriesIndex) : '');
      }
      return;
    }
    if (action === 'clearSeries') {
      // Clearing the label on one book would leave a 丛书 that is now a different
      // set; "取消丛书" has to mean every member.
      setActionError('');
      try {
        for (const member of books) await runtime.api.patchBookMetadata(member.id, { series: '', seriesIndex: null });
        await refreshShelf();
      } catch (error) { setActionError(error instanceof Error ? error.message : '取消丛书失败，请稍后重试。'); }
      return;
    }
    setActionError('');
    try {
      await runtime.api.setReadingStatus(book.id, action === 'clear' ? null : action);
      await refreshShelf();
    } catch (error) { setActionError(error instanceof Error ? error.message : '标记失败，请稍后重试。'); }
  };
  const menuOptions = (books: Book[]) => {
    // A 丛书 is edited and cleared as a set: the card represents all of them.
    if (books.length > 1) return [
      { value: 'editSeries', label: `编辑整组丛书（${books.length} 册）` },
      { value: 'seriesDetail', label: `丛书详情（${books.length} 册）` },
      { value: 'clearSeries', label: '取消丛书（整组）' },
    ];
    const book = books[0];
    return [
      { value: 'detail', label: '书籍详情' },
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
      await refreshShelf();
    } catch (error) { setActionError(error instanceof Error ? error.message : '保存失败，请稍后重试。'); }
  };

  /** Reorders the 丛书 draft — one path for the drag handle and the ↑/↓ buttons. */
  const moveInOrder = (from: number, to: number) => {
    setEditOrder(list => {
      if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
      const next = [...list];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };
  const removeFromSeries = (book: Book) => {
    setEditOrder(list => list.filter(item => item.id !== book.id));
    setEditRemoved(list => list.some(item => item.id === book.id) ? list : [...list, book]);
  };
  const restoreToSeries = (book: Book) => {
    setEditRemoved(list => list.filter(item => item.id !== book.id));
    setEditOrder(list => list.some(item => item.id === book.id) ? list : [...list, book]);
  };
  /**
   * Saves the managed 丛书: the removed books lose their label, the rest are
   * renumbered 1..N in the order the reader put them in.
   *
   * Renumbering rather than keeping the old numbers is the point of the drag:
   * the whole list is re-sequenced, so a gap left by a removed volume closes.
   */
  const saveManagedSeries = async () => {
    if (!editTarget) return;
    setActionError('');
    try {
      for (const book of editRemoved) await runtime.api.patchBookMetadata(book.id, { series: '', seriesIndex: null });
      const name = editSeries.trim();
      for (let i = 0; i < editOrder.length; i++) {
        await runtime.api.patchBookMetadata(editOrder[i].id, { series: name, seriesIndex: i + 1 });
      }
      setEditTarget(null);
      await refreshShelf();
    } catch (error) { setActionError(error instanceof Error ? error.message : '保存失败，请稍后重试。'); }
  };
  // ---- 分组筛选：一级组是书架上的按钮，二级/三级/四级在这个面板里（或 / 与 / 非）----
  /** The default group is applied once per mount (see the effect below). */
  const defaultApplied = useRef(false);
  const allGroups = groups.data ?? [];
  /** The reader's own groups: the derived kinds (folder, 未分组) are not choosable. */
  const manualGroups = useMemo(() => allGroups.filter(isManualGroup), [allGroups]);
  /**
   * The section the shelf is showing.
   *
   * A URL may name a subgroup (`?groups=<二级组 id>`), so the top-level group is
   * looked up from the path rather than assumed to be selected itself: that keeps
   * one top-level button pressed and decides which blocks the sheet offers.
   */
  const activeLevel1 = useMemo(() => activeTopGroupOf(allGroups, groupIds), [groupIds, allGroups]);
  /**
   * The 分组 chip's own filters (everything below the top level), as `groups`
   * values — one value per chip, because a merged chip is one condition.
   */
  const subGroupFilters = useMemo(() => subGroupValuesOf(allGroups, groupIds), [groupIds, allGroups]);
  /**
   * The default group: the shelf opens on it when the URL names no filter.
   *
   * Applied once per mount instead of on every render — 清除分组 writes a URL with
   * no `groups`, and re-applying the default would make that button look broken.
   * A reload starts the section again, which is the point of calling it default.
   */
  useEffect(() => {
    if (defaultApplied.current || !groups.data) return;
    defaultApplied.current = true;
    if (params.get('groups')) return;
    const fallback = defaultGroup(groups.data);
    if (fallback) go({ groups: [groupFilterValue(fallback)] });
    // `go` is rebuilt every render; the ref above is what keeps this a one-shot.
  }, [groups.data, params]);
  /**
   * The names behind one `groups` value, for a chip's accessible label.
   *
   * A merged value also carries a folder id, which is not in the list (the server
   * folded it into the manual group) — those parts contribute no name of their own.
   */
  const filterLabel = (value: string) => {
    const names = groupFilterIds(value)
      .map(id => groups.data?.find(group => group.id === id)?.name)
      .filter((name): name is string => Boolean(name));
    return names.length > 0 ? names.join(' · ') : '已删除的分组';
  };
  /** One top-level group at a time; pressing the active one goes back to the default. */
  const toggleLevel1 = (group: BookGroup) => {
    if (activeLevel1?.id === group.id) {
      const fallback = defaultGroup(allGroups);
      go({ groups: fallback ? [groupFilterValue(fallback)] : null });
      return;
    }
    go({ groups: [groupFilterValue(group)] });
  };
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
    setEditMode('batch');
    setEditOrder([]);
    setEditRemoved([]);
    setEditTarget(books);
    setEditSeries('');
    setEditIndex('1');
  };
  /** Saves the 书籍详情 sheet: metadata overrides first, then this book's groups. */
  const saveBookDetail = async (draft: BookMetadataDraft, nextGroupIds: string[]) => {
    const book = detailTarget;
    if (!book) return;
    setDetailBusy(true);
    setDetailError('');
    try {
      const patch: Record<string, unknown> = {};
      if (draft.title !== (book.title ?? '')) patch.title = draft.title;
      if (draft.author !== (book.author ?? '')) patch.author = draft.author;
      if (draft.description !== (book.description ?? '')) patch.description = draft.description;
      if (draft.series !== (book.series ?? '')) patch.series = draft.series;
      if ((draft.seriesIndex ?? null) !== (book.seriesIndex ?? null)) patch.seriesIndex = draft.seriesIndex;
      if (Object.keys(patch).length > 0) await runtime.api.patchBookMetadata(book.id, patch);
      await runtime.api.setBookGroups(book.id, nextGroupIds);
      setDetailTarget(null);
      await refreshShelf();
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : '保存失败，请稍后重试。');
    } finally { setDetailBusy(false); }
  };
  /** Undo one manual field; the sheet stays open on the restored value. */
  const clearBookField = async (field: 'title' | 'author' | 'description' | 'series') => {
    const book = detailTarget;
    if (!book) return;
    setDetailBusy(true);
    setDetailError('');
    try {
      const updated = await runtime.api.clearBookMetadataField(book.id, field);
      setDetailTarget(updated);
      await refreshShelf();
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : '撤销失败，请稍后重试。');
    } finally { setDetailBusy(false); }
  };
  /** Files every volume of a 丛书 into the same groups (one write per book). */
  const saveSeriesDetail = async () => {
    const books = seriesTarget;
    if (!books) return;
    setSeriesTargetBusy(true);
    setSeriesTargetError('');
    try {
      for (const book of books) await runtime.api.setBookGroups(book.id, seriesTargetIds);
      setSeriesTarget(null);
      await refreshShelf();
    } catch (error) {
      setSeriesTargetError(error instanceof Error ? error.message : '保存失败，请稍后重试。');
    } finally { setSeriesTargetBusy(false); }
  };
  const remove = async (book: Book | ContinueReadingItem) => { await runtime.api.browseBatchShelf({ bookIds: [book.id] }, 'remove'); await refreshShelf(); };
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
        <GroupFilterBar
          groups={allGroups}
          activeLevel1={activeLevel1}
          subFilterCount={subGroupFilters.length}
          subFilterLabel={subGroupFilters.map(filterLabel).join('、')}
          showCounts
          onToggleLevel1={toggleLevel1}
          onOpenFilter={() => setGroupsOpen(true)}
        />
      </div>
      <FloatingNotice message={actionError} error />
      {(!query.isPending && (cards.length > 0 || queryText || filtered)) && <div className="shelf-toolbar"><span className="shelf-count muted">{queryText ? `找到 ${query.data?.total ?? 0} 本` : `共 ${query.data?.total ?? 0} 本`}</span><div className="shelf-sort" role="group" aria-label="排序方式">{SHELF_SORTS.map(option => <button key={option.value} type="button" className="chip" aria-pressed={option.value === sort} onClick={() => onSort(option.value)}>{option.label}</button>)}</div><button type="button" className="chip" aria-pressed={selectMode} onClick={() => { setSelectMode(v => !v); if (selectMode) setSelected(new Set()); }}>{selectMode ? '取消选择' : '批量标记'}</button></div>}
      {query.isPending && <><FloatingNotice message="正在加载书架…" busy /><BookGridSkeleton density={settings.shelfDensity} /></>}
      {query.error && <Callout tone="error" title="书架加载失败">{query.error.message}</Callout>}
      {query.data && cards.length === 0 && filtered && !queryText && <div className="empty-state collection-empty"><BookOpen className="empty-glyph" aria-hidden="true" /><p>{status ? `还没有${readingLabels[status]}的书` : '这个分组里没有书'}</p><p className="muted">{status === 'want' ? '在书籍的“⋯”菜单里可以标记想读。' : '换一个分类，或查看全部书籍。'}</p><div className="empty-actions"><button type="button" className="button" onClick={clearFilters}>查看全部书籍</button></div></div>}
      {query.data && cards.length === 0 && !(filtered && !queryText) && <div className="empty-state collection-empty"><BookOpen className="empty-glyph" aria-hidden="true" /><p>{queryText ? '没有匹配的书' : '书架还没有书'}</p><p className="muted">{queryText ? '换个关键词，或者检查一下作者名的写法' : '从书库挑选喜欢的书，或通过书源搜索，加入书架后就能开始阅读。'}</p><div className="empty-actions">{queryText ? <button type="button" className="button" onClick={clearSearch}>清除搜索</button> : <><Link className="button primary" to="/sources"><Search size={16} />去搜书</Link><Link className="button" to="/library"><LibraryBig size={16} />打开书库</Link></>}</div></div>}
      {selectMode && <div className="shelf-batch-bar"><button type="button" className="chip" onClick={() => { const all = cards.map(b => (b as Book).id); const allSel = all.length > 0 && all.every(id => selected.has(id)); setSelected(allSel ? new Set() : new Set(all)); }}>{selected.size === cards.length && cards.length > 0 ? '取消全选' : '全选'}</button><span className="muted">已选 {selected.size}</span><button type="button" className="button primary" disabled={selected.size === 0} onClick={startBatchEdit}>标记为丛书</button></div>}
      {folded.length > 0 && <div className="book-grid" data-density={settings.shelfDensity} data-show-author={String(settings.shelfShowAuthor)} data-show-progress={String(settings.shelfShowProgress)} data-selecting={String(selectMode)}>{selectMode ? cards.map(book => <BookCard key={book.id} book={book as Book} showAuthor={settings.shelfShowAuthor} showProgress={settings.shelfShowProgress} selecting selected={selected.has((book as Book).id)} onToggle={() => toggleSelect(book)} />) : folded.map(entry => 'id' in entry ? <BookCard key={entry.id} book={entry as Book} showAuthor={settings.shelfShowAuthor} showProgress={settings.shelfShowProgress} cache={cacheProgressOf(entry as Book, serverCache)} onRemove={() => setMenuTarget([entry as Book])} /> : <SeriesCard key={'s:' + entry.series[0].series} books={entry.series} showAuthor={settings.shelfShowAuthor} cache={seriesCacheProgress(entry.series, serverCache)} onRemove={list => setMenuTarget(list)} />)}</div>}
      {query.data && pages > 1 && <nav className="shelf-pager" aria-label="翻页"><button type="button" disabled={page <= 1} onClick={() => go({ page: page - 1 })}>上一页</button><span>{page} / {pages}</span><button type="button" disabled={page >= pages} onClick={() => go({ page: page + 1 })}>下一页</button></nav>}
    </section>
    {settingsOpen && <ShelfSettingsSheet settings={settings} onPatch={patch => { void runtime.updateSettings(patch); }} onClose={() => setSettingsOpen(false)} onOpenExternalReader={() => { setSettingsOpen(false); setOpdsOpen(true); }} />}
    {opdsOpen && <OpdsAccess api={runtime.api} onSignedOut={() => { void runtime.api.signOut(); }} onClose={() => { setOpdsOpen(false); setSettingsOpen(true); }} />}
    {menuTarget && <DialogView dialog={{ kind: 'pick', title: menuTarget.length > 1 ? `${menuTarget[0].series || '丛书'}（${menuTarget.length} 册）` : `《${menuTarget[0].title || '未命名'}》`, options: menuOptions(menuTarget), resolve: (_value: string | null) => undefined } satisfies Dialog} destructive={menuTarget.length > 1 ? '' : '从书架拿掉'} onClose={answer => { const target = menuTarget; setMenuTarget(null); if (typeof answer === 'string' && answer) void act(target, answer as BookAction); }} />}
    {groupsOpen && <GroupFilterSheet
      groups={allGroups}
      selected={groupIds}
      modes={groupModes}
      activeLevel1={activeLevel1}
      pending={groups.isPending}
      error={groups.error}
      extraFooter={<Link className="button" to="/shelf/groups">管理分组</Link>}
      onApply={({ groups: next, modes }) => { setGroupsOpen(false); go({ groups: next.length > 0 ? next : null, groupModes: modes }); }}
      onClose={() => setGroupsOpen(false)}
    />}
    {detailTarget && <BookDetailSheet
      key={`${detailTarget.id}:${detailTarget.updatedAt}`}
      book={detailTarget}
      groups={manualGroups}
      busy={detailBusy}
      error={detailError}
      onSave={(draft, nextGroupIds) => void saveBookDetail(draft, nextGroupIds)}
      onClearField={field => void clearBookField(field)}
      onClose={() => { if (!detailBusy) setDetailTarget(null); }}
    />}
    {seriesTarget && <Sheet
      title={`丛书详情 · ${seriesTarget[0].series || '未命名'}`}
      subtitle={`${seriesTarget.length} 册`}
      busy={seriesTargetBusy}
      onClose={() => { if (!seriesTargetBusy) setSeriesTarget(null); }}
      footer={<>
        <button type="button" className="button" disabled={seriesTargetBusy} onClick={() => setSeriesTarget(null)}>取消</button>
        <button type="button" className="button primary" disabled={seriesTargetBusy} onClick={() => void saveSeriesDetail()}>保存分组</button>
      </>}>
      <div className="sheet-form">
        {seriesTargetError && <Callout tone="error">{seriesTargetError}</Callout>}
        <div className="sheet-field">
          <label>分组<span className="muted">（整组统一设置，可多选）</span></label>
          {manualGroups.length === 0
            ? <p className="sheet-text muted">还没有分组。</p>
            : <div className="chip-row" role="group" aria-label="选择分组">
              {manualGroups.map(group => <button key={group.id} type="button" className="chip"
                aria-pressed={seriesTargetIds.includes(group.id)}
                aria-label={`${group.name}，${group.bookCount} 本`}
                disabled={seriesTargetBusy}
                onClick={() => setSeriesTargetIds(current => (current.includes(group.id)
                  ? current.filter(id => id !== group.id)
                  : [...current, group.id]))}>
                {group.name}
              </button>)}
            </div>}
          <p className="sheet-text muted">保存后这 {seriesTarget.length} 册都会设成所选分组；原来各自的分组会被覆盖。</p>
        </div>
        <div className="sheet-field">
          <label>包含的册</label>
          <ul className="series-order">
            {[...seriesTarget].sort((a, b) => (a.seriesIndex ?? 0) - (b.seriesIndex ?? 0)).map(book => <li key={book.id} className="series-order-item">
              <span className="series-order-num">{book.seriesIndex ?? '·'}</span>
              <Link className="series-order-title" to={`/book/${encodeURIComponent(book.id)}`}>{book.title || '未命名'}</Link>
            </li>)}
          </ul>
        </div>
      </div>
    </Sheet>}
    {removeTarget && <DialogView dialog={{ kind: 'confirm', title: '移出书架', body: `确定要将《${removeTarget.title}》移出书架吗？`, resolve: (_answer: boolean) => undefined } satisfies Dialog} destructive="移出书架" onClose={answer => { const target = removeTarget; setRemoveTarget(null); if (answer === true) void remove(target); }} />}
    {editTarget && editMode === 'manage' && <Sheet title={`管理丛书 · ${editTarget[0].series || '未命名'}`} onClose={() => setEditTarget(null)} footer={<><button type="button" className="button" onClick={() => setEditTarget(null)}>取消</button><button type="button" className="button primary" onClick={() => void saveManagedSeries()}>保存</button></>}>
      <div className="sheet-form">
        <div className="sheet-field"><label htmlFor="manage-series-name">丛书名</label><input id="manage-series-name" type="text" value={editSeries} onChange={e => setEditSeries(e.currentTarget.value)} placeholder="例如：三体" /></div>
      </div>
      <h4 className="series-order-heading">册顺序<span className="muted">拖动或用箭头调整，保存后按新顺序重编号</span></h4>
      <ul className="series-order">
        {editOrder.map((book, index) => <li key={book.id} className="series-order-item" data-dragging={dragIndex === index ? 'true' : undefined}
          draggable onDragStart={() => setDragIndex(index)} onDragEnd={() => setDragIndex(null)}
          onDragOver={event => { event.preventDefault(); }} onDrop={event => { event.preventDefault(); if (dragIndex != null) moveInOrder(dragIndex, index); setDragIndex(null); }}>
          <span className="series-order-num">{index + 1}</span>
          <span className="series-order-title">{book.title || '未命名'}</span>
          <button type="button" className="series-order-step" aria-label="上移" disabled={index === 0} onClick={() => moveInOrder(index, index - 1)}>↑</button>
          <button type="button" className="series-order-step" aria-label="下移" disabled={index === editOrder.length - 1} onClick={() => moveInOrder(index, index + 1)}>↓</button>
          <button type="button" className="series-order-remove" onClick={() => removeFromSeries(book)}>移出</button>
        </li>)}
      </ul>
      {editOrder.length === 0 && <p className="sheet-text">这一组已经没有书了，保存后丛书会消失。</p>}
      {editRemoved.length > 0 && <>
        <h4 className="series-order-heading">将移出丛书<span className="muted">保存后恢复为普通书籍</span></h4>
        <ul className="series-order">
          {editRemoved.map(book => <li key={book.id} className="series-order-item is-removed">
            <span className="series-order-title">{book.title || '未命名'}</span>
            <button type="button" className="series-order-remove" onClick={() => restoreToSeries(book)}>放回</button>
          </li>)}
        </ul>
      </>}
    </Sheet>}
    {editTarget && editMode === 'batch' && <Sheet title={editTarget.length === 1 ? `编辑丛书 · 《${editTarget[0].title}》` : `批量标记丛书（${editTarget.length} 本）`} onClose={() => setEditTarget(null)} footer={<><button type="button" className="button" onClick={() => setEditTarget(null)}>取消</button><button type="button" className="button primary" onClick={() => void saveEditSeries()}>保存</button></>}><div className="sheet-form"><div className="sheet-field"><label htmlFor="series-name">丛书名</label><input id="series-name" type="text" value={editSeries} onChange={e => setEditSeries(e.currentTarget.value)} placeholder="例如：三体" /></div><div className="sheet-field"><label htmlFor="series-index">编号</label><input id="series-index" type="number" min="1" step="1" value={editIndex} onChange={e => setEditIndex(e.currentTarget.value)} placeholder={editTarget.length > 1 ? '起始编号（自动递增）' : '例如：1'} /></div>{editTarget.length > 1 && <p className="sheet-text">将从第 {Number(editIndex) || 1} 号开始，按当前顺序递增分配。</p>}</div></Sheet>}
  </div>;
}
