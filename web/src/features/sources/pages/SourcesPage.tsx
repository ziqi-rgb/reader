import { Sheet } from '../../../ui/sheet.tsx';
import { Button, Callout, IconTextButton } from '../../../ui/toolkit.tsx';
import { SourcesHeader } from '../components/SourcesHeader.tsx';
import { SourceBookDetailSheet } from '../components/SourceBookDetailSheet.tsx';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Plus, Search } from 'lucide-react';
import type { ExtensionField, SourceEntry, SourcePage, SerialFilter, SerialStatus } from '../../../api/sources.ts';
import { useRuntime } from '../../../app/providers/runtime-context.tsx';
import { FloatingNotice } from '../../../ui/floating-notice.tsx';
import { useAuthStore } from '../../../shared/stores/auth.store.ts';
import { mergePages } from './SourceCatalogPage.tsx';
import { newId } from '../../../core/id.ts';
import { SearchableSelect } from '../../../ui/searchable-select.tsx';
import { groupSourceResults } from '../../../ui/source-results.ts';
import { CatalogFeedback } from '../../../ui/catalog-feedback.tsx';
import { ActionMenu } from '../../../ui/action-menu.tsx';
import { PluginManager } from '../components/PluginManager.tsx';
import { useBookGroups } from '../../shelf/queries/shelf.queries.ts';
import { activeTopGroupOf, groupFilterIds, groupFilterValue, groupPathLabel, subGroupValuesOf, type GroupModes } from '../../shelf/groups.ts';
import { GroupFilterBar, GroupFilterSheet } from '../../shelf/components/group-filter.tsx';

type SourceTab = 'search' | 'sources' | 'updates' | 'plugins';
type SearchState = 'idle' | 'searching' | 'stopped' | 'complete' | 'error' | 'limited';

export function SourcesPage() {
  const runtime = useRuntime();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const admin = useAuthStore(state => state.verifiedUser?.role === 'admin');
  // /sources/plugins opens the hub on its 插件管理 tab.
  const [tab, setTab] = useState<SourceTab>(useLocation().pathname === '/sources/plugins' ? 'plugins' : 'search');
  const [sourceId, setSourceId] = useState('');
  const [keyword, setKeyword] = useState('');
  const [managing, setManaging] = useState<string | null>(null);
  const [catalogPage, setCatalogPage] = useState<SourcePage>();
  const [catalogError, setCatalogError] = useState('');
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogFilters, setCatalogFilters] = useState<Record<string, string>>({});
  const [detail, setDetail] = useState<SourceEntry | null>(null);
  const [searchState, setSearchState] = useState<SearchState>('idle');
  /**
   * The search this page is currently showing, and the session it belongs to.
   *
   * State rather than refs: the split button and its menu are drawn from these two,
   * so "is there something to continue" has to be part of the render — a ref could
   * leave the button offering 继续搜索 while the resume itself was refused.
   */
  const [searchPlan, setSearchPlan] = useState<{ query: string; filters: Record<string, string> } | null>(null);
  const [searchSession, setSearchSession] = useState<string | null>(null);
  const [resultGroupKey, setResultGroupKey] = useState<string | null>(null);
  const [resultGroupQuery, setResultGroupQuery] = useState('');
  const [sourceNameQuery, setSourceNameQuery] = useState('');
  const [acquired, setAcquired] = useState<{ id: string; ref: string; title: string } | null>(null);
  const searchRun = useRef<AbortController | null>(null);
  const catalogEpoch = useRef(0);
  const sources = useQuery({ queryKey: ['sources', runtime.api.baseUrl], queryFn: () => runtime.api.sources() });
  const types = useQuery({ queryKey: ['source-types', runtime.api.baseUrl], queryFn: () => runtime.api.sourceTypes(), staleTime: 300_000 });
  /**
   * 追更 filters: the reader's own four-level groups and the hand-marked 连载状态.
   *
   * Both live in component state rather than the URL: the 追更 tab is a working
   * list, not a shareable view of the shelf, and its address is the tab itself.
   * The filtering is done by the server (the same predicate the shelf uses) so the
   * two screens can never disagree about what 「小说.奇幻」 means.
   */
  const [serialFilter, setSerialFilter] = useState<'all' | SerialFilter>('unfinished');
  const [groupFilter, setGroupFilter] = useState<string[]>([]);
  const [groupModes, setGroupModes] = useState<GroupModes>({ 2: 'or', 3: 'or', 4: 'or' });
  const [groupSheetOpen, setGroupSheetOpen] = useState(false);
  const subscriptions = useQuery({
    queryKey: ['subscriptions', runtime.api.baseUrl, groupFilter.join(','), groupModes[2], groupModes[3], groupModes[4], serialFilter],
    queryFn: () => runtime.api.subscriptions({
      groups: groupFilter,
      groupModes,
      ...(serialFilter === 'all' ? {} : { serial: serialFilter }),
    }),
    enabled: tab === 'updates',
  });
  /**
   * The tab's 有更新 dot, read separately from the list.
   *
   * The list is filtered, so a 已完结 filter that hides a book with new chapters
   * would also hide the dot — the one thing the dot exists to say. Fetched only
   * while the reader is on another tab, which is the only time it is drawn.
   */
  const unread = useQuery({
    queryKey: ['subscriptions-unread', runtime.api.baseUrl],
    queryFn: () => runtime.api.subscriptions(),
    staleTime: 30_000,
    enabled: tab !== 'updates',
  });
  const groups = useBookGroups(tab === 'updates');
  const allGroups = groups.data ?? [];
  const activeLevel1 = useMemo(() => activeTopGroupOf(allGroups, groupFilter), [allGroups, groupFilter]);
  const subGroupFilters = useMemo(() => subGroupValuesOf(allGroups, groupFilter), [allGroups, groupFilter]);
  const [busy, setBusy] = useState<string | null>(null);
  /** The last "检查更新" failure, said in words rather than as an error code. */
  const [updateError, setUpdateError] = useState('');
  const enabledSources = (sources.data ?? []).filter(source => source.enabled && source.descriptor);
  const selectedSourceId = sourceId || enabledSources.find(source => source.isDefault)?.id || enabledSources[0]?.id || '';
  const selectedSource = enabledSources.find(source => source.id === selectedSourceId);
  const sourceFilters = useQuery({ queryKey: ['source-filters', runtime.api.baseUrl, selectedSourceId], queryFn: () => runtime.api.sourceFilters(selectedSourceId), enabled: !!selectedSourceId && !!selectedSource?.descriptor?.capabilities.includes('search.filters') });
  const detailQuery = useQuery({ queryKey: ['source-detail', runtime.api.baseUrl, selectedSourceId, detail?.ref], queryFn: () => runtime.api.sourceDetail(selectedSourceId, detail!.ref), enabled: !!detail });
  const acquire = useMutation({ mutationFn: ({ ref, option }: { ref: string; option?: string }) => runtime.api.acquireSource(selectedSourceId, ref, option), onError: reason => setCatalogError(reason instanceof Error ? reason.message : '加入书架失败') });
  const grouped = searchState !== 'idle' && !(selectedSource?.descriptor?.builtin && selectedSource.sourceType === 'local');
  const results = groupSourceResults(catalogPage?.items ?? [], grouped);
  const activeGroup = results.find(group => group.key === resultGroupKey);
  // A provider that reports a limit (limitReached) still hands back a cursor: the same
  // "继续搜索" path resumes from it instead of forcing the user to start over.
  const canResume = !!searchSession && !!searchPlan
    && !!(catalogPage?.nextCursor || searchState === 'stopped' || searchState === 'error')
    && keyword.trim() === searchPlan.query && JSON.stringify(catalogFilters) === JSON.stringify(searchPlan.filters);
  const resume = canResume && (searchState === 'stopped' || searchState === 'error' || searchState === 'limited');
  const filterOptions = (field: ExtensionField) => {
    const parent = catalogFilters[field.changeAction ?? field.dependsOn ?? ''];
    return (field.options ?? []).filter(option => !parent || !option.parentValues || option.parentValues.includes(parent));
  };
  useEffect(() => { if (!sourceId && selectedSourceId) setSourceId(selectedSourceId); }, [selectedSourceId, sourceId]);
  const sourceTypeLabel = (id: string) => types.data?.find(item => item.id === id)?.label ?? id;
  const loadCatalog = async (ref?: string) => {
    if (!selectedSourceId || !selectedSource?.descriptor?.capabilities.includes('browse')) return;
    const epoch = ++catalogEpoch.current;
    setCatalogBusy(true); setCatalogError(''); setSearchState('idle'); setResultGroupKey(null); setAcquired(null);
    try { const page = await runtime.api.sourceCatalog(selectedSourceId, ref ? { ref } : {}); if (catalogEpoch.current === epoch) setCatalogPage(page); }
    catch (reason) { if (catalogEpoch.current === epoch) setCatalogError(reason instanceof Error ? reason.message : '目录加载失败'); }
    finally { if (catalogEpoch.current === epoch) setCatalogBusy(false); }
  };
  const stopSearch = () => { searchRun.current?.abort(); searchRun.current = null; setCatalogBusy(false); setSearchState('stopped'); };
  const searchSources = async (append = false) => {
    const request = append ? searchPlan : { query: keyword.trim(), filters: { ...catalogFilters } };
    if (!request?.query || !selectedSource) return;
    // 继续搜索被拒绝时必须说出来：一个停在原地的按钮看起来就是坏的。
    if (append && !canResume) {
      setCatalogError(searchSession ? '这次搜索已经结束，没有可以接着取的结果；可点「重新搜索」重新开始。' : '还没有搜索过，没有可以继续的结果。');
      return;
    }
    // 前一轮还在跑时由这一轮接管，而不是让点击落进空处。
    searchRun.current?.abort();
    const run = new AbortController(); searchRun.current = run; ++catalogEpoch.current;
    const current = () => searchRun.current === run;
    const sessionId = append ? searchSession! : newId();
    setCatalogBusy(true); setCatalogError(''); setSearchState('searching');
    if (!append) { setCatalogPage(undefined); setSearchSession(sessionId); setAcquired(null); setResultGroupKey(null); }
    setSearchPlan(request);
    try {
      let merged: SourcePage | undefined = append ? catalogPage : undefined;
      for await (const page of runtime.api.searchSource(selectedSource.id, { ...request, sessionId, ...(append && catalogPage?.nextCursor ? { cursor: catalogPage.nextCursor } : {}), resultLimit: 10000 }, { signal: run.signal })) {
        if (!current()) return;
        merged = mergePages(merged, page); setCatalogPage(merged);
        if (page.limitReached) { setSearchState('limited'); break; }
      }
      if (current()) setSearchState(previous => previous === 'limited' ? previous : 'complete');
    } catch (reason) { if (current()) { setCatalogError(reason instanceof Error ? reason.message : '搜索失败，已保留找到的书籍。'); setSearchState('error'); } }
    finally { if (current()) { searchRun.current = null; setCatalogBusy(false); } }
  };
  const acquireEntry = (entry: SourceEntry, option?: string) => acquire.mutate(option === undefined ? { ref: entry.ref } : { ref: entry.ref, option }, { onSuccess: result => { if (result.kind === 'action-required') setCatalogError(result.action?.label ?? '请先完成授权'); else if (result.publicationId) { setAcquired({ id: result.publicationId, ref: entry.ref, title: entry.title }); void queryClient.invalidateQueries({ queryKey: ['shelf'] }); } } });
  const mutateSubscription = async (id: string, enabled?: boolean) => {
    setBusy(id); setUpdateError('');
    try {
      if (enabled === undefined) await runtime.api.refreshPublication(id);
      else await runtime.api.configureSubscription(id, { enabled });
      await queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
    } catch (reason) {
      // A refused directory (the source lost chapters) reads as a connection
      // failure to the reader, so say what happened instead of failing silently.
      setUpdateError(reason instanceof Error ? reason.message : '检查失败，已保留原目录');
    } finally { setBusy(null); }
  };
  /**
   * Marks 连载中 / 已完结 / 未标记 on a followed book.
   *
   * The reader's own answer — a source's directory does not say whether a book is
   * finished — so it is a write, and the list is re-read before anything is shown.
   */
  const markSerial = async (id: string, serialStatus: SerialStatus | null) => {
    setBusy(id); setUpdateError('');
    try {
      await runtime.api.configureSubscription(id, { serialStatus });
      await queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
    } catch (reason) {
      setUpdateError(reason instanceof Error ? reason.message : '标记失败，请稍后重试');
    } finally { setBusy(null); }
  };
  const items = subscriptions.data ?? [];
  /** Has anything narrowed the 追更 list? Decides the wording of an empty state. */
  const filtered = serialFilter !== 'all' || groupFilter.length > 0;
  /**
   * The names behind one `groups` value, for the filter chip's label.
   *
   * A value with no group behind it (a deleted group) still counts as a filter, so
   * it has to have a name here too.
   */
  const filterLabelOf = (value: string) => {
    const names = groupFilterIds(value)
      .map(id => allGroups.find(group => group.id === id)?.name)
      .filter((name): name is string => Boolean(name));
    return names.length > 0 ? names.join(' · ') : '已删除的分组';
  };
  /**
   * The book this entry already is for this reader.
   *
   * `entry.bookId` comes from the server (matched on source instance + entry ref);
   * the local `acquired` map covers the book added a moment ago, before the next
   * search refreshes the list.
   */
  const ownedBookId = (entry: SourceEntry): string | undefined =>
    entry.bookId ?? (acquired?.ref === entry.ref ? acquired.id : undefined);

  const updateSource = async (id: string, patch: { enabled?: boolean; isDefault?: boolean }) => { setBusy(id); try { await runtime.api.saveSource(id, patch); await sources.refetch(); setManaging(null); } finally { setBusy(null); } };
  useEffect(() => {
    ++catalogEpoch.current; searchRun.current?.abort(); searchRun.current = null;
    setCatalogBusy(false); setCatalogPage(undefined); setCatalogError(''); setCatalogFilters({}); setDetail(null); setSearchSession(null);
    setSearchState('idle'); setKeyword(''); setResultGroupKey(null); setResultGroupQuery(''); setSourceNameQuery(''); setSearchPlan(null);
    if (selectedSource?.descriptor?.capabilities.includes('browse')) void loadCatalog();
    return () => { ++catalogEpoch.current; searchRun.current?.abort(); searchRun.current = null; };
  }, [selectedSourceId]);
  useEffect(() => { if (detail && detailQuery.data) setDetail({ ...detail, ...detailQuery.data }); }, [detailQuery.data]);
  return <div className="sources-screen sources-hub">
    <SourcesHeader title="书源与追更" backTo="/shelf" />
    <nav className="sources-tabs" role="tablist" aria-label="书源功能">
      {([['search', '搜书'], ['sources', '书源管理'], ['updates', '自动追更'], ...(admin ? [['plugins', '插件管理']] : [])] as Array<[SourceTab, string]>).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}{id === 'updates' && (unread.data ?? subscriptions.data ?? []).some(item => item.newChapters > 0) && <span className="sources-tab-dot" aria-label="有更新" />}</button>)}
    </nav>
    <main className="sources-body" role="tabpanel">
      {tab === 'search' && <>
        <section className="sources-card source-picker">
          <div><h2>搜书</h2><p className="muted">选择来源，发现想读的书。</p></div>
          <SearchableSelect label="选择来源" value={selectedSourceId} options={enabledSources.map(source => ({ value: source.id, label: source.name + (source.isDefault ? '（默认）' : '') }))} onChange={setSourceId} />
          {!selectedSourceId && <p className="muted">{enabledSources.length ? '选择来源后，即可搜索书籍或浏览目录。' : '暂无可用来源，请先添加或启用来源。'}</p>}
          {/* An empty state names its way out: the fix for "no source" lives on the next tab. */}
          {!selectedSourceId && !enabledSources.length && <IconTextButton className="primary source-picker-cta" icon="plus" label="前往书源管理" onClick={() => setTab('sources')} />}
        </section>
        {selectedSource && <section className="sources-card source-catalog"><h2>搜索与浏览</h2>
          {catalogError && <Callout tone="error" onDismiss={() => setCatalogError('')}>{catalogError}</Callout>}
          {selectedSource.descriptor?.capabilities.includes('search') && <form className="sources-search" onSubmit={event => { event.preventDefault(); void searchSources(resume); }}>
            {sourceFilters.data?.map(field => field.type === 'text'
              ? <label key={field.key} className="source-keyword">{field.label}<input type="search" placeholder={field.placeholder ?? ''} disabled={catalogBusy} value={catalogFilters[field.key] ?? ''} onChange={event => setCatalogFilters(previous => ({ ...previous, [field.key]: event.currentTarget.value }))} /></label>
              : field.type === 'select'
                ? <SearchableSelect key={field.key} label={field.label} value={catalogFilters[field.key] ?? ''} disabled={catalogBusy} options={filterOptions(field)} onChange={value => setCatalogFilters(previous => { const next = { ...previous, [field.key]: value }; for (const dependent of sourceFilters.data ?? []) { if ((dependent.changeAction ?? dependent.dependsOn) === field.key && !dependent.options?.some(option => option.value === next[dependent.key] && (!option.parentValues || !value || option.parentValues.includes(value)))) next[dependent.key] = ''; } return next; })} />
                : null)}
            <label className="source-keyword">搜索书籍<input type="search" placeholder="输入书名或作者" required disabled={catalogBusy} value={keyword} onChange={event => setKeyword(event.currentTarget.value)} /></label>
            {searchState === 'searching' ? <button className="button search-stop" type="button" onClick={stopSearch}>停止搜索</button> : <div className="search-split"><button className="button primary" type="submit" disabled={catalogBusy}><Search size={16} />{resume ? '继续搜索' : '搜索'}</button>{searchPlan && <ActionMenu label="搜索选项" icon="chevron-right" className="search-menu-toggle" items={[
              // Picking either one runs the same path as the two submit buttons, so a menu
              // can never disagree with what the split button itself would do.
              { label: canResume ? '继续搜索（保留结果）' : '继续搜索（已搜完）', disabled: !canResume, onSelect: () => void searchSources(true) },
              { label: '重新搜索（清空结果）', onSelect: () => void searchSources(false) },
            ]} />}</div>}
          </form>}
          {searchState !== 'idle' && <div className="search-progress" role="status"><span>{({ searching: '正在搜索', stopped: '已停止搜索', complete: '搜索完成', error: '搜索中断', limited: '本次搜索已达上限，可点「继续搜索」接着取' })[searchState]}{catalogPage?.batch ? ` · 已检查 ${catalogPage.batch.completed} / ${catalogPage.batch.total} 个来源` : ''} · 已找到 {results.length} 本书</span>{catalogPage?.batch && <progress aria-label="书源搜索进度" max={Math.max(1, catalogPage.batch.total)} value={catalogPage.batch.completed} />}</div>}
          {catalogPage && grouped && <label className="catalog-group-filter">筛选分组<input type="search" placeholder="搜索书名或作者" value={resultGroupQuery} onChange={event => setResultGroupQuery(event.currentTarget.value)} /></label>}
          {catalogPage && <CatalogFeedback page={catalogPage} count={results.length} merged={searchState !== 'idle'} searching={searchState === 'searching'} />}
          {catalogPage?.navigation && <div className="source-navigation">{catalogPage.navigation.map(item => <Button  key={item.ref} onClick={() => void loadCatalog(item.ref)}>{item.title}</Button>)}</div>}
          {catalogBusy && !catalogPage && <FloatingNotice message="正在加载目录…" busy />}
          {catalogPage && <div className="source-results">{results.filter(group => { const q = resultGroupQuery.trim().toLocaleLowerCase(); return !q || group.entry.title.toLocaleLowerCase().includes(q) || group.entry.authors?.some(author => author.toLocaleLowerCase().includes(q)); }).map(group => {
            // A grouped row (one title across several sources) says how many of them
            // are already on the shelf; a single row just says so.
            const ownedCount = group.entries.filter(entry => ownedBookId(entry)).length;
            const badge = grouped ? (ownedCount > 0 ? `已在书架 ${ownedCount}/${group.entries.length}` : '') : (ownedBookId(group.entry) ? '已在书架' : '');
            const bookId = grouped ? '' : (ownedBookId(group.entry) ?? '');
            return <article className="sources-row catalog-book" key={group.key}>
              <div><strong>{group.entry.title}</strong>{badge && <span className="catalog-owned">{badge}</span>}<small>{group.entry.authors?.join(' / ') || '作者未知'}</small>{!grouped && group.entry.description && <p className="source-description">{group.entry.description}</p>}</div>
              {grouped
                ? <button className="button catalog-source-count" type="button" onClick={() => setResultGroupKey(group.key)}><span>{group.entries.length} 条书源</span><ChevronRight size={16} /></button>
                : <div className="sources-actions"><button className="button" type="button" onClick={() => setDetail(group.entry)}>详情</button>{bookId
                  ? <Link className="button primary" to={`/book/${encodeURIComponent(bookId)}`}>去阅读</Link>
                  : (group.entry.options?.length ? group.entry.options : [{ id: '', label: '加入书架' }]).map(option => <button className="button primary" type="button" key={option.id} disabled={option.available === false || acquire.isPending} onClick={() => acquireEntry(group.entry, option.id)}>{option.label}</button>)}</div>}
            </article>;
          })}</div>}
          {catalogPage && !catalogBusy && !catalogPage.items.length && <div className="catalog-empty"><strong>没有找到匹配书籍</strong><p>试试其他关键词，或调整搜索范围。</p></div>}
          {(searchState === 'complete' || searchState === 'limited') && catalogPage?.nextCursor && <div className="catalog-pagination"><button className="button" type="button" disabled={!canResume} onClick={() => void searchSources(true)}>加载更多结果</button></div>}
          {acquired && <button className="button" type="button" onClick={() => navigate(`/book/${encodeURIComponent(acquired.id)}`)}>阅读《{acquired.title}》</button>}
        </section>}
      </>}
      {tab === 'sources' && <section className="sources-card sources-list">
        <div className="sources-list-heading"><h2>我的来源 <span className="source-count">{sources.data?.length ?? 0}</span></h2>{admin && <Link className="button source-add" to="/sources/manage/new"><Plus size={16} />添加来源</Link>}</div>
        {sources.isPending && <FloatingNotice message="正在加载书源…" busy />}{sources.error && <p className="notice error">{sources.error.message}</p>}{!sources.isPending && !sources.data?.length && <p className="muted">还没有配置书源。请添加来源或启用插件。</p>}
        {(sources.data ?? []).map(source => <article className="sources-row source-entry" key={source.id}><div className="source-entry-top"><div className="source-entry-info"><strong>{source.name}{source.isDefault && <span className="source-default-badge">默认</span>}</strong><small>{source.descriptor?.label ?? sourceTypeLabel(source.sourceType)}</small><span className={'source-state' + (source.enabled ? ' is-enabled' : '')}>{source.enabled ? '已启用' : '已暂停'}</span></div><div className="source-entry-actions">{source.descriptor?.credentialKeys?.length ? <Link className="button" to={'/sources/' + encodeURIComponent(source.id) + '/credentials'}>书源登录</Link> : null}{admin && <button className="source-manage-trigger" type="button" aria-expanded={managing === source.id} onClick={() => setManaging(current => current === source.id ? null : source.id)}>管理<ChevronRight size={16} /></button>}</div></div>{admin && managing === source.id && <div className="source-management" role="group" aria-label={`${source.name}管理`}>{source.descriptor?.extensions?.pages?.map(page => <Link className="source-management-link" key={page.id} to={'/sources/' + encodeURIComponent(source.id) + '/' + encodeURIComponent(page.id)}>{page.title}<ChevronRight size={16} /></Link>)}<Link className="source-management-link" to={'/sources/manage/' + encodeURIComponent(source.id)}>基本设置<ChevronRight size={16} /></Link><button className="source-management-link" type="button" disabled={busy === source.id || (!source.isDefault && (!source.enabled || !source.descriptor?.capabilities.includes('search')))} onClick={() => void updateSource(source.id, { isDefault: !source.isDefault })}>{source.isDefault ? '取消默认' : '设为默认'}</button><button className="source-management-link source-toggle" type="button" disabled={busy === source.id} onClick={() => void updateSource(source.id, { enabled: !source.enabled })}>{source.enabled ? '暂停' : '启用'}</button></div>}</article>)}
      </section>}
      {tab === 'updates' && <section className="sources-card follow-card">
        <h2>自动追更</h2>
        <p className="notice">服务端定时检查目录，浏览器关闭后继续运行。正文和图片在阅读时缓存。目录只接受新增章节：上游减少章节时本次检查作废，已发布的目录保持不变。</p>
        {updateError && <FloatingNotice message={updateError} error />}
        {/* 连载状态与分组是同一行上的两个筛子：书多了以后，追更列表和书架一样需要它们。 */}
        <div className="shelf-filters follow-filters">
          <div className="shelf-status" role="group" aria-label="连载状态">
            {SERIAL_CHOICES.map(choice => <button key={choice.value} type="button" className="chip"
              aria-pressed={serialFilter === choice.value}
              onClick={() => setSerialFilter(choice.value)}>{choice.label}</button>)}
          </div>
          <GroupFilterBar
            groups={allGroups}
            activeLevel1={activeLevel1}
            subFilterCount={subGroupFilters.length}
            subFilterLabel={subGroupFilters.map(filterLabelOf).join('、')}
            onToggleLevel1={group => {
              if (activeLevel1?.id === group.id) setGroupFilter([]);
              else setGroupFilter([groupFilterValue(group)]);
            }}
            onOpenFilter={() => setGroupSheetOpen(true)}
          />
        </div>
        {subscriptions.isPending && <FloatingNotice message="正在加载追更列表…" busy />}
        {!subscriptions.isPending && <p className="follow-count muted">{filtered ? `筛选出 ${items.length} 本` : `共 ${items.length} 本`}{serialHint(serialFilter)}</p>}
        {!subscriptions.isPending && !items.length && <div className="catalog-empty">
          <strong>{filtered ? '当前筛选里没有书' : '还没有追更中的书'}</strong>
          <p>{filtered ? '换一个分组、换一个连载状态，或者查看全部。' : '先从章节书源加入书籍，再开启追更。'}</p>
          {filtered && <button className="button" type="button" onClick={() => { setSerialFilter('all'); setGroupFilter([]); }}>查看全部</button>}
        </div>}
        {items.map(item => <article className="sources-row follow-row" key={item.bookId}>
          <div>
            <strong>{item.title}<span className={'follow-serial' + (item.serialStatus ? ' is-' + item.serialStatus : '')}>{item.serialStatus ? SERIAL_LABEL[item.serialStatus] : '未标记'}</span></strong>
            {(item.groups ?? []).length > 0 && <span className="follow-groups">{(item.groups ?? []).map(group => <span className="follow-group" key={group.id}>{groupPathLabel(group.name)}</span>)}</span>}
            <small>{item.newChapters ? '新增 ' + item.newChapters + ' 章 · ' : ''}上次成功：{item.lastSuccessAt ? new Date(item.lastSuccessAt).toLocaleString() : '尚未检查'}</small>
            <small>{item.enabled ? '下次检查：' + new Date(item.nextCheckAt).toLocaleString() : '自动追更已关闭'}{item.lastError ? ' · 检查失败：' + subscriptionError(item.lastError) : ''}</small>
          </div>
          <div className="sources-actions">
            <label className="source-interval">检查间隔<select aria-label={`${item.title}检查间隔`} value={item.intervalMinutes} disabled={busy === item.bookId} onChange={event => { const intervalMinutes = Number(event.currentTarget.value); setBusy(item.bookId); void runtime.api.configureSubscription(item.bookId, { intervalMinutes }).then(() => queryClient.invalidateQueries({ queryKey: ['subscriptions'] })).finally(() => setBusy(null)); }}><option value="15">15 分钟</option><option value="60">1 小时</option><option value="360">6 小时</option><option value="1440">1 天</option></select></label>
            <button className="button" type="button" disabled={busy === item.bookId} onClick={() => void mutateSubscription(item.bookId, !item.enabled)}>{item.enabled ? '关闭追更' : '开启追更'}</button>
            <button className="button" type="button" disabled={busy === item.bookId} onClick={() => void mutateSubscription(item.bookId)}>立即检查</button>
            <Link className="button" to={'/book/' + encodeURIComponent(item.bookId)}>阅读</Link>
            {/* 连载状态 is the reader's own note, so it is a menu pick on the row rather than a filter-only field. */}
            <ActionMenu label={`${item.title}的连载状态`} title={`标记《${item.title}》`} items={[
              { label: '标记为连载中', checked: item.serialStatus === 'ongoing', disabled: busy === item.bookId, onSelect: () => void markSerial(item.bookId, 'ongoing') },
              { label: '标记为已完结', checked: item.serialStatus === 'completed', disabled: busy === item.bookId, onSelect: () => void markSerial(item.bookId, 'completed') },
              { label: '清除标记', checked: item.serialStatus === null, disabled: busy === item.bookId, onSelect: () => void markSerial(item.bookId, null) },
            ]} />
          </div>
        </article>)}
      </section>}
      {tab === 'plugins' && (admin ? <PluginManager /> : <Callout tone="warning">只有管理员可以管理插件</Callout>)}
    </main>
    {activeGroup && <Sheet title="书源列表" subtitle={`${activeGroup.entries.length} 条书源`} onClose={() => { setResultGroupKey(null); setSourceNameQuery(''); }}>
      <div className="sheet-form">
        <p className="sheet-text">{activeGroup.entry.title}</p>
        <input className="catalog-source-search" type="search" aria-label="搜索书源" placeholder="搜索书源" value={sourceNameQuery} onChange={event => setSourceNameQuery(event.currentTarget.value)} />
        {activeGroup.entries.filter(entry => (entry.sourceName ?? selectedSource?.name ?? '').toLocaleLowerCase().includes(sourceNameQuery.trim().toLocaleLowerCase())).map(entry => {
          const option = entry.options?.[0];
          const bookId = ownedBookId(entry);
          return <article className="catalog-source-item" key={entry.ref}>
            <div><strong>{entry.sourceName ?? selectedSource?.name}{bookId && <span className="catalog-owned">已在书架</span>}</strong><p className="source-description">最新章节：{entry.latestChapter || '暂无信息'}</p></div>
            <div className="sources-actions"><Button onClick={() => setDetail(entry)}>详情</Button>{bookId
              ? <Link className="button primary" to={`/book/${encodeURIComponent(bookId)}`}>去阅读</Link>
              : <Button className="primary" disabled={option?.available === false} onClick={() => acquireEntry(entry, option?.id)}>{option?.label ?? '加入书架'}</Button>}</div>
          </article>;
        })}
      </div>
    </Sheet>}
    {detail && <SourceBookDetailSheet detail={detail} pending={detailQuery.isPending} error={detailQuery.error} acquiring={acquire.isPending} onAcquire={acquireEntry} onClose={() => setDetail(null)} />}
    {groupSheetOpen && <GroupFilterSheet
      groups={allGroups}
      selected={groupFilter}
      modes={groupModes}
      activeLevel1={activeLevel1}
      pending={groups.isPending}
      error={groups.error}
      showCounts={false}
      extraFooter={<Link className="button" to="/shelf/groups">管理分组</Link>}
      onApply={({ groups: next, modes }) => { setGroupSheetOpen(false); setGroupFilter(next); setGroupModes(modes); }}
      onClose={() => setGroupSheetOpen(false)}
    />}
  </div>;
}

/**
 * The 连载状态 chips, in the order the reader thinks in: what I still follow,
 * what is running, what I finished, and everything.
 *
 * 「未完结」 is the default because it is the answer to "which of these still need
 * checking" — it hides the books the reader has marked 已完结 without hiding the
 * ones they have not marked at all.
 */
const SERIAL_CHOICES: Array<{ value: 'all' | SerialFilter; label: string }> = [
  { value: 'unfinished', label: '未完结' },
  { value: 'ongoing', label: '连载中' },
  { value: 'completed', label: '已完结' },
  { value: 'all', label: '全部' },
];
const SERIAL_LABEL: Record<SerialStatus, string> = { ongoing: '连载中', completed: '已完结' };

/** The sentence after the count, so 「筛选出 8 本」 says what it was filtered by. */
function serialHint(filter: 'all' | SerialFilter): string {
  if (filter === 'unfinished') return ' · 已隐藏「已完结」';
  if (filter === 'ongoing') return ' · 只看「连载中」';
  if (filter === 'completed') return ' · 只看「已完结」';
  return '';
}

/**
 * The failure codes a subscription check can record, said in words.
 *
 * The list shows `lastError`, and an error code is not an answer to "did my book
 * update?": the two that actually happen are a source that cannot be reached and a
 * directory that lost chapters, and both leave the previous directory intact.
 */
function subscriptionError(code: string): string {
  if (code === 'CHAPTER_LIST_SHRUNK') return '上游章节出现异常（章节减少），已保留原目录';
  if (code === 'UPDATE_FAILED') return '无法连接上游，已保留原目录';
  if (code === 'SOURCE_DISABLED') return '书源已停用';
  if (code === 'PLUGIN_UNAVAILABLE') return '书源插件不可用';
  return code;
}
