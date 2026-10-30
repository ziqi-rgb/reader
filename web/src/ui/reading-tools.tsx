import type { ReadingOverrides } from './reading-overrides.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmSheet, Sheet } from './sheet.tsx';
import type { ReaderApi } from '../api/client.ts';
import type { ChapterCacheInfo, Manifest, Note } from '../api/types.ts';
import type { OfflineStore } from '../store/offline.ts';
import type { SessionCache } from '../store/session-cache.ts';
import type { SyncEngine } from '../core/sync.ts';
import { PublicationCache } from '../store/publications.ts';
import { BookTransfer, type TransferMode, type TransferState } from '../core/book-transfer.ts';
import { decodeAnchor, encodeAnchor, findText, type SearchHit, type TextAnchor } from './text-anchor.ts';
import { ApiError } from '../api/errors.ts';
import { newId } from '../core/id.ts';
import { FloatingNotice } from './floating-notice.tsx';

export interface SearchSection { id: string; title: string; text: string }

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} B`;
}
export interface ReadingToolsProps {
  api: ReaderApi; cache: PublicationCache; offline: OfflineStore; sync: SyncEngine; manifest: Manifest;
  /** Chapter text cached for this browser session only (dropped when it closes). */
  session: SessionCache;
  selection: TextAnchor | null; locator: string; returnLocator: string;
  sections(signal: AbortSignal): AsyncGenerator<SearchSection>;
  navigate(target: TextAnchor | string): Promise<void>;
  overrides: ReadingOverrides;
  saveOverrides(value: ReadingOverrides): Promise<void>;
  undoOverrides(): Promise<void>;
  previewHeadings(prefix: string): Promise<string[]>;
  onNotes(): void; onClose(): void;
  previewSpeech(): Promise<string>; stopPreview(): void;
}

export function ReadingTools(props: ReadingToolsProps) {
  const [tab, setTab] = useState<'search' | 'notes' | 'offline' | 'speech' | 'edit'>(props.selection ? 'notes' : 'search');
  const [query, setQuery] = useState(''), [hits, setHits] = useState<SearchHit[]>([]);
  const [scanned, setScanned] = useState(0), [searching, setSearching] = useState(false);
  const [searchMode, setSearchMode] = useState('服务端搜索'), [searchTotal, setSearchTotal] = useState(0);
  const [searchFailures, setSearchFailures] = useState<Array<{title: string; code: string}>>([]);
  const [message, setMessage] = useState('');
  const [messageError,setMessageError] = useState(false);
  const [replacement, setReplacement] = useState(''), [prefix, setPrefix] = useState(props.overrides.headingPrefix);
  const [headingPreview, setHeadingPreview] = useState<string[] | null>(null), [saving, setSaving] = useState(false);
  async function edit(work: () => Promise<void>) { if (saving) return; setSaving(true); await action(work); if (alive.current) setSaving(false); }
  const [notes, setNotes] = useState<Note[]>(props.offline.notesFor(props.manifest.book.id));
  const [comment, setComment] = useState(''), [editing, setEditing] = useState<Note | null>(null);
  const [color, setColor] = useState('#ffd54f');
  const [composing, setComposing] = useState(!!props.selection);
  const [noteFilter, setNoteFilter] = useState<'all' | 'bookmark' | 'annotation'>('all');
  const [deleteId, setDeleteId] = useState('');
  const editorRef = useRef<HTMLDivElement>(null);
  const bookId = props.manifest.book.id;
  const book = props.manifest.book;
  const totalChapters = props.manifest.content?.total ?? 1;
  /**
   * Whether the content is addressed chapter by chapter. The server splits a TXT
   * by the reader's own rules too (a heading prefix, their chapter marks), so its
   * chapter references stay valid even then — which is what keeps a customised
   * book from having to be downloaded whole.
   */
  const ranged = (book.format === 'chapters' || book.format === 'txt') && !!props.manifest.content;
  const [from, setFrom] = useState(1), [to, setTo] = useState(totalChapters);
  const [transfer, setTransfer] = useState<TransferState | null>(null);
  const [server, setServer] = useState<ChapterCacheInfo | null>(null);
  const [clearServer, setClearServer] = useState(false);
  const [usage, setUsage] = useState(0), [books, setBooks] = useState<Array<{ id: string; bytes: number }>>([]);
  const [removeId, setRemoveId] = useState('');
  const [returnTo] = useState(props.returnLocator);
  const searchRun = useRef<AbortController | null>(null), alive = useRef(true);
  const task = useMemo(
    () => new BookTransfer(props.api, props.cache, props.session, props.manifest, state => { if (alive.current) setTransfer(state); }, { perChapter: ranged }),
    [props.manifest, ranged],
  );
  const visibleNotes = notes.filter(note => noteFilter === 'all' || (noteFilter === 'bookmark' ? note.type === 'bookmark' : note.type !== 'bookmark'));
  const bookmarked = notes.some(note => note.type === 'bookmark' && note.locator === props.locator);
  useEffect(() => { if (editing || composing) editorRef.current?.querySelector('textarea')?.focus(); }, [editing, composing]);
  async function storage() {
    const entries = await props.cache.entries(), grouped = new Map<string, number>();
    for (const entry of entries) grouped.set(entry.bookId, (grouped.get(entry.bookId) ?? 0) + entry.bytes);
    if (!alive.current) return;
    setUsage(entries.reduce((sum, e) => sum + e.bytes, 0)); setBooks([...grouped].map(([id, bytes]) => ({ id, bytes })));
  }
  async function action(work: () => Promise<unknown>) {
    setMessage('');setMessageError(false);
    try { await work(); } catch (error) { if (alive.current) {setMessageError(true);setMessage(error instanceof Error ? error.message : '操作失败');} }
  }
  useEffect(() => {
    void action(async () => {
      const info = await task.serverInfo();
      if (alive.current) setServer(info);
      await storage();
    });
    return () => { alive.current = false; searchRun.current?.abort(); if (task.state.status === 'running') void task.pause().catch(() => undefined); props.stopPreview(); };
  }, []);

  /** Run one destination to completion, then refresh what the panel reports. */
  async function startTransfer(mode: TransferMode) {
    await action(async () => {
      await task.start(mode, ranged ? from : undefined, ranged ? to : undefined);
      if (alive.current) setServer(await task.serverInfo());
      await storage();
    });
  }
  async function search() {
    searchRun.current?.abort(); const run = searchRun.current = new AbortController();
    setHits([]); setScanned(0); setSearching(true); setMessage('');setMessageError(false);
    setSearchFailures([]); setSearchTotal(0); setSearchMode('服务端搜索');
    const found: SearchHit[] = []; let count = 0;
    try {
      try {
        let cursor: string | undefined; const failed: Array<{title: string; code: string}> = [];
        do {
          const page = await props.api.searchBook(bookId,query.trim(),cursor,{signal:run.signal});
          run.signal.throwIfAborted();
          found.push(...page.hits.slice(0,200-found.length)); failed.push(...page.failures);
          if (alive.current) { setHits([...found]); setScanned(page.scanned); setSearchTotal(page.total); setSearchFailures([...failed]); }
          if (page.limited || found.length >= 200) { setMessage('已显示前 200 个命中，请缩小关键词范围'); break; }
          cursor = page.nextCursor;
        } while (cursor);
        return;
      } catch (error) {
        run.signal.throwIfAborted();
        if (!(error instanceof ApiError) || (!error.isConnectivity && error.code !== 'SEARCH_LOCAL_LAYOUT')) throw error;
        found.length = 0; setHits([]); setSearchFailures([]); setSearchTotal(0);
        setSearchMode(error.code === 'SEARCH_LOCAL_LAYOUT' ? '本地搜索（自定义目录）' : '离线搜索（仅已缓存内容）');
      }
      for await (const section of props.sections(run.signal)) {
        run.signal.throwIfAborted();
        found.push(...findText(section.id, section.title, section.text, query.trim(), 200 - found.length));
        if (alive.current) { setHits([...found]); setScanned(++count); }
        if (found.length >= 200) { setMessage('已显示前 200 个命中，请缩小关键词范围'); break; }
      }
    } catch (error) {
      if (!run.signal.aborted && alive.current) {setMessageError(true);setMessage(error instanceof Error ? error.message : '搜索失败，已有结果保留');}
    } finally { if (searchRun.current === run && alive.current) setSearching(false); }
  }
  async function saveNote(bookmark = false) {
    const selected = props.selection;
    if (!bookmark && !editing && !selected) throw new Error('先在正文选择文字，再打开阅读工具');
    const note: Note = editing && !bookmark ? { ...editing, type: editing.type === 'bookmark' ? 'bookmark' : comment.trim() ? 'note' : 'highlight', comment, color, updatedAt: Date.now() } : {
      id: newId(), bookId, type: bookmark ? 'bookmark' : comment.trim() ? 'note' : 'highlight',
      locator: bookmark ? props.locator : encodeAnchor(selected!), text: bookmark ? props.manifest.book.title : selected!.quote,
      comment: bookmark ? '' : comment, color: bookmark ? '' : color, updatedAt: Date.now(),
    };
    await props.offline.upsertNotes([note]); props.sync.schedule();
    setNotes(props.offline.notesFor(bookId));
    if (!bookmark) { setComment(''); setEditing(null); setComposing(false); }
    setNoteFilter(bookmark ? 'bookmark' : 'all'); props.onNotes(); setMessage(bookmark ? '已添加当前位置书签' : '笔记已保存');
  }
  return <Sheet title="阅读工具" busy={saving} onClose={props.onClose}>
    <div className="reading-tools">
      <nav className="reading-tool-tabs" aria-label="阅读工具分类">{([
        ['search', '搜索', '书内搜索'], ['notes', '笔记', '笔记'], ['offline', '缓存', '离线缓存'], ['speech', '朗读', '朗读检测'], ['edit', '整理', '内容整理'],
        ] as const).map(([id, label, accessible]) => <button key={id} className="reading-tool-tab" type="button" aria-label={accessible} aria-pressed={tab === id} aria-controls="reading-tool-panel" onClick={() => { setTab(id); setMessage(''); }}>{label}</button>)}</nav>
      <div className="reading-tool-panel" id="reading-tool-panel">
      <FloatingNotice message={message} error={messageError} />
      {deleteId && <ConfirmSheet danger title="删除笔记" text="确定删除这条笔记或书签？" confirmText="确认删除" onCancel={()=>setDeleteId('')} onConfirm={()=>{const id=deleteId;setDeleteId('');void edit(async()=>{await props.offline.deleteNote(id);props.sync.schedule();setNotes(props.offline.notesFor(bookId));props.onNotes();});}} />}
      {removeId && <ConfirmSheet danger title="清理缓存" text="只删除此设备的书籍缓存，保留原书、进度和笔记。" confirmText="确认清理" cancelText="保留缓存" onCancel={()=>setRemoveId('')} onConfirm={()=>{const id=removeId;setRemoveId('');void action(async()=>{await props.cache.removeBook(id);await storage();});}} />}
      {tab === 'search' && <section aria-label="书内搜索">
        <h3>书内搜索</h3>
        <form className="reading-tool-search" onSubmit={event => { event.preventDefault(); if (query.trim()) void search(); }}><label>关键词<input placeholder="输入要查找的文字" value={query} maxLength={200} onInput={event => setQuery(event.currentTarget.value)} /></label><button className="button primary" disabled={searching || !query.trim()}>搜索全文</button></form>
        {searching && <button className="button" onClick={() => { searchRun.current?.abort(); setSearching(false); }}>停止搜索</button>}
        <p role="status">{searchMode} · 已扫描 {scanned}{searchTotal ? ` / ${searchTotal}` : ''} 章，找到 {hits.length} 处</p>
        {!!searchFailures.length && <details className="reading-tool-advanced"><summary>{searchFailures.length} 章读取失败，搜索结果可能不完整</summary><ul>{searchFailures.map((failure,index)=><li key={index}>{failure.title} · {failure.code}</li>)}</ul></details>}
        <button className="button" disabled={!returnTo} onClick={() => void action(async () => { await props.navigate(returnTo); props.onClose(); })}>返回原阅读位置</button>
        <ol className="reading-tool-results">{hits.map((hit, index) => <li key={index}><button className="button" onClick={() => void action(async () => { await props.navigate(hit.anchor); props.onClose(); })}><strong>{hit.title}</strong><span>{hit.excerpt}</span></button></li>)}</ol>
      </section>}
      {tab === 'notes' && <section aria-label="笔记管理">
        <div className="reading-tool-heading"><h3>笔记与书签 <small>{notes.length}</small></h3><button className="button" aria-label={bookmarked ? '已添加当前位置书签' : '添加当前位置书签'} disabled={saving || !props.locator || bookmarked} onClick={() => void edit(() => saveNote(true))}>{bookmarked ? '已加书签' : '＋ 加书签'}</button></div>
        {(editing || composing) && <div className="reading-note-editor" ref={editorRef}>
          <h4>{editing ? '编辑' + (editing.type === 'bookmark' ? '书签' : '笔记') : '记录所选文字'}</h4>
          <blockquote>{editing?.text ?? props.selection?.quote}</blockquote>
          <label><span>批注 <small>可选</small></span><textarea aria-label="批注" disabled={saving} placeholder={editing?.type === 'bookmark' ? '为这个位置添加备注' : '写下想法，或留空仅保存高亮'} value={comment} maxLength={4000} onInput={event => setComment(event.currentTarget.value)} /></label>
          {editing?.type !== 'bookmark' && <div className="reading-note-colors" role="group" aria-label="高亮颜色"><span>高亮颜色</span>{[['#ffd54f', '黄色'], ['#80cbc4', '绿色'], ['#ce93d8', '紫色']].map(([value, label]) => <button key={value} type="button" disabled={saving} aria-label={label} aria-pressed={color === value} style={{ '--note-color': value }} onClick={() => setColor(value)}>{color === value ? '✓' : ''}</button>)}</div>}
          <div className="reading-tool-actions"><button className="button" disabled={saving} onClick={() => { setEditing(null); setComposing(false); setComment(''); }}>取消编辑</button><button className="button primary" disabled={saving} onClick={() => void edit(() => saveNote())}>{editing ? '保存修改' : comment.trim() ? '保存批注' : '保存高亮'}</button></div>
        </div>}
        {!editing && !composing && props.selection && <button className="button" onClick={() => setComposing(true)}>为所选文字添加笔记</button>}
        {!editing && !composing && <><div className="reading-note-filters" role="group" aria-label="笔记筛选">{([['all', '全部'], ['bookmark', '书签'], ['annotation', '高亮与批注']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={noteFilter === value} onClick={() => { setNoteFilter(value); setDeleteId(''); }}>{label}</button>)}</div>
        <ul className="reading-note-list">{visibleNotes.map(note => <li key={note.id}>
          <button className="reading-note-open" disabled={saving} onClick={() => void action(async () => { await props.navigate(decodeAnchor(note.locator) ?? note.locator); props.onClose(); })}><span className="reading-note-kind">{note.type === 'bookmark' ? '书签' : note.type === 'highlight' ? '高亮' : '批注'}<span>跳转阅读 ›</span></span><strong>{note.text || '书签'}</strong>{note.comment && <span className="reading-note-comment">{note.comment}</span>}</button>
          <div className="reading-note-actions"><button type="button" disabled={saving} onClick={() => { setEditing(note); setComment(note.comment); setColor(note.color || '#ffd54f'); }}>编辑</button><button type="button" disabled={saving} onClick={() => setDeleteId(note.id)}>删除笔记</button></div>
        </li>)}</ul>
        {!visibleNotes.length && <div className="reading-tool-empty"><strong>{noteFilter === 'bookmark' ? '还没有书签' : noteFilter === 'annotation' ? '还没有高亮或批注' : '还没有阅读记录'}</strong><p>加书签，记住当前读到的位置。<br />在正文选中文字后，可添加高亮或批注。</p>{!props.selection && <button className="button" onClick={props.onClose}>返回正文</button>}</div>}</>}
      </section>}
      {tab === 'offline' && <section aria-label="离线与下载">
        <p>三个去处：下载到服务器（NAS 保留，所有设备共用）、缓存到浏览器（关闭浏览器自动清除）、下载到本地（保存为文件）。后两者会先把章节下载到服务器，再从这里取，不会重复请求上游。</p>
        {ranged && <div className="reading-tool-range"><label>起始章<input type="number" min={1} max={totalChapters} value={from} onInput={e => setFrom(Number(e.currentTarget.value))} /></label><label>结束章<input type="number" min={from} max={totalChapters} value={to} onInput={e => setTo(Number(e.currentTarget.value))} /></label></div>}
        {book.format === 'chapters'
          ? <p>服务器已缓存 {server?.chapters ?? 0} / {server?.total ?? totalChapters} 章 · {formatBytes(server?.bytes ?? 0)}</p>
          : <p>这本书的文件已经在服务器上，不需要再下载到服务器。</p>}
        <div className="reading-tool-actions">
          {transfer?.status === 'running' ? <button className="button" onClick={() => void action(() => task.pause())}>停止</button> : <>
            {book.format === 'chapters' && <button className="button" disabled={!from || to < from} onClick={() => void startTransfer('server')}>下载到服务器</button>}
            <button className="button primary" disabled={!from || to < from} onClick={() => void startTransfer('session')}>缓存到浏览器</button>
            <button className="button" disabled={!from || to < from} onClick={() => void startTransfer('download')}>下载到本地</button>
          </>}
        </div>
        {transfer && <p role="status">{transfer.message}{transfer.status === 'running' && transfer.total > 1 ? ` · ${transfer.completed}/${transfer.total}` : ''}</p>}
        {!!transfer?.failed.length && <details className="reading-tool-advanced"><summary>{transfer.failed.length} 章下载失败，可重试</summary><ul>{transfer.failed.slice(0, 100).map((failure, index) => <li key={index}>{failure.title} · {failure.code}</li>)}</ul></details>}
        <p>本次浏览器会话缓存 {formatBytes(props.cache.sessionBytes(bookId))} <button className="button" onClick={() => void action(async () => { props.cache.clearSession(bookId); })}>清除会话缓存</button></p>
        {clearServer && <ConfirmSheet danger title="清除服务器缓存" text="只删除服务器上这本书的章节缓存，书籍本身和阅读进度都不受影响；下次阅读会重新向书源请求。" confirmText="确认清除" onCancel={() => setClearServer(false)} onConfirm={() => { setClearServer(false); void action(async () => { await task.clearServer(); setServer(await task.serverInfo()); }); }} />}
        {!!server?.chapters && <button className="button" onClick={() => setClearServer(true)}>清除服务器缓存（{server.chapters} 章）</button>}
        {usage > 0 && <details className="reading-tool-advanced"><summary>清理设备上的旧缓存（{formatBytes(usage)}）</summary><div>
        <p>旧版本曾把读过的章节留在这台设备上。这些内容已不再被使用，删除只影响本设备，不会动服务器缓存、阅读进度和笔记。</p>
        <ul>{books.map(book => <li key={book.id}>{props.offline.current.books[book.id]?.title ?? (book.id === bookId ? props.manifest.book.title : book.id)} · {(book.bytes / 1024 / 1024).toFixed(1)} MiB <button className="button" disabled={transfer?.status === 'running'} onClick={() => setRemoveId(book.id)}>清理缓存</button></li>)}</ul>
        </div></details>}
      </section>}
      {tab === 'edit' && <section aria-label="内容整理">
        <p>个人整理规则保存在服务器，联网时保存；原书保持不变。清空替换内容可过滤选中的文字。</p>
        <blockquote>{props.selection?.quote ?? '请先在正文选择需要纠正的文字'}</blockquote>
        <label>替换为<textarea maxLength={4000} value={replacement} onInput={e => setReplacement(e.currentTarget.value)} /></label>
        <button className="button" disabled={saving || !props.selection || props.selection.quote.length > 4000} onClick={() => void edit(async () => { await props.saveOverrides({ ...props.overrides, corrections: [...props.overrides.corrections, {id: newId(),anchor:props.selection!,replacement}] }); setMessage('纠错已保存，正文已更新'); })}>保存纠错 / 过滤</button>
        <ul>{props.overrides.corrections.map(c => <li key={c.id}>{c.anchor.quote.slice(0,60)} → {c.replacement.slice(0,60) || '（过滤）'} <button className="button" disabled={saving} onClick={() => void edit(() => props.saveOverrides({ ...props.overrides,corrections:props.overrides.corrections.filter(item => item.id !== c.id) }))}>移除此项</button></li>)}</ul>
        <button className="button" disabled={saving || props.overrides.version === 0} onClick={() => void edit(async () => { await props.undoOverrides(); setMessage('已撤销上一次整理修改'); })}>撤销上一次整理修改</button>
        {props.manifest.book.format === 'txt' && <>
          <h3>手动分章</h3><p>在正文选中一段文字后点「分章」，这一段就成为新章节的开头，之后的内容都属于新章节。分割点保存在服务器，由服务器重新划分章节，原书不变，也不会为此下载整本文件。</p>
          <ul>{props.overrides.chapterMarks.map(mark => <li key={mark.id}>{mark.title} <button className="button" disabled={saving} onClick={() => void edit(() => props.saveOverrides({ ...props.overrides, chapterMarks: props.overrides.chapterMarks.filter(item => item.id !== mark.id) }))}>移除此分割点</button></li>)}</ul>
          {!props.overrides.chapterMarks.length && <p>还没有手动分割点。</p>}
          <h3>TXT 目录规则</h3><p>匹配以指定文字开头、长度不超过 80 字的行；留空恢复自动识别。规则保存在服务器，应用后由服务器重新划分章节并从首章打开，旧笔记仍保留；预览由服务器直接计算，不需要下载文件。</p>
          <label>常用模板<select value="" onChange={e => { setPrefix(e.currentTarget.value); setHeadingPreview(null); }}><option value="">自动识别</option><option value="第">中文章回</option><option value="Chapter ">英文 Chapter</option><option value="【">方括号标题</option></select></label>
          <label>标题开头<input maxLength={60} value={prefix} onInput={e => { setPrefix(e.currentTarget.value); setHeadingPreview(null); }} /></label>
          <button className="button" disabled={saving} onClick={() => void edit(async () => setHeadingPreview(await props.previewHeadings(prefix)))}>预览目录</button>
          {headingPreview && <><p>识别 {headingPreview.length} 个章节，展示前 100 项</p><ol>{headingPreview.slice(0,100).map((title,i) => <li key={i}>{title}</li>)}</ol><button className="button" disabled={saving} onClick={() => void edit(async () => { await props.saveOverrides({ ...props.overrides, headingPrefix:prefix }); setMessage('目录规则已保存'); })}>应用预览规则</button></>}
        </>}
      </section>}
      {tab === 'speech' && <section aria-label="朗读检测"><p>使用当前朗读设置试听。HTTP 引擎会请求服务端合成试听音频。</p><button className="button" onClick={() => void action(async () => setMessage(await props.previewSpeech()))}>检测并试听</button><button className="button" onClick={props.stopPreview}>停止试听</button><p>若浏览器限制播放，请点击试听后允许音频；可在朗读设置切换系统或 HTTP 引擎。</p></section>}
      </div>
    </div>
  </Sheet>;
}
