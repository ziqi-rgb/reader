import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronLeft } from 'lucide-react';
import { Callout } from '../../../ui/toolkit.tsx';
import { Sheet } from '../../../ui/sheet.tsx';
import { useRuntime } from '../../../app/providers/runtime-context.tsx';
import { useBookGroups } from '../queries/shelf.queries.ts';
import type { BookGroup } from '../../../api/types.ts';
import '../styles/groups.css';

/**
 * 分组管理: the reader's own shelf structure, editable in one place.
 *
 * Separate from 系列 and 标签 on purpose — those come out of the file and a rescan
 * rewrites them. A group is per account and a book may sit in several, so this page
 * owns create / rename / delete while 书籍详情 owns "which groups is *this* book in".
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
    void run(async () => { await runtime.api.createBookGroup(value); setName(''); }, '创建分组失败');
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

  return <div className="sources-screen groups-screen">
    <header className="groups-header">
      <Link className="button" to="/shelf"><ChevronLeft size={16} />书架</Link>
      <h1>分组管理</h1>
    </header>
    <main className="groups-body">
      <p className="muted groups-intro">分组是你自己的书架结构：一本书可以同时在多个分组里，和文件里的系列、标签无关（那两项由文件决定，重新扫描会变）。在书架卡片上长按「书籍详情」可以把书放进分组。</p>

      <form className="groups-create" onSubmit={event => { event.preventDefault(); create(); }}>
        <label className="groups-create-field">新分组<input type="search" placeholder="例如：催眠·常识修改" value={name} disabled={busy} onChange={event => setName(event.currentTarget.value)} /></label>
        <button type="submit" className="button primary" disabled={busy || !name.trim()}>新建</button>
      </form>

      {error && <Callout tone="error">{error}</Callout>}
      {groups.error && <Callout tone="error">分组读取失败：{groups.error.message}</Callout>}
      {groups.isPending && <p className="muted">正在读取分组…</p>}
      {!groups.isPending && !groups.error && (groups.data?.length ?? 0) === 0 && <div className="empty-state"><p>还没有分组</p><p className="muted">在上面输入一个名字就能创建第一个分组。</p></div>}

      <ul className="groups-list">
        {(groups.data ?? []).map(group => <li key={group.id} className="groups-row">
          <div className="groups-row-text"><strong>{group.name}</strong><small className="muted">{group.bookCount} 本</small></div>
          <div className="groups-row-actions">
            <Link className="button" to={`/shelf?groups=${encodeURIComponent(group.id)}`}>查看书架</Link>
            <button type="button" className="button" disabled={busy} onClick={() => { setRenaming(group); setRenameValue(group.name); }}>重命名</button>
            <button type="button" className="button" disabled={busy} onClick={() => setDeleting(group)}>删除</button>
          </div>
        </li>)}
      </ul>
    </main>

    {renaming && <Sheet title="重命名分组" busy={busy} onClose={() => setRenaming(null)}
      footer={<>
        <button type="button" className="button" onClick={() => setRenaming(null)}>取消</button>
        <button type="button" className="button primary" disabled={busy || !renameValue.trim()} onClick={rename}>保存</button>
      </>}>
      <div className="sheet-form">
        <div className="sheet-field"><label htmlFor="group-rename">分组名</label>
          <input id="group-rename" type="text" value={renameValue} disabled={busy} onChange={event => setRenameValue(event.currentTarget.value)} /></div>
      </div>
    </Sheet>}

    {deleting && <Sheet title="删除分组" busy={busy} onClose={() => setDeleting(null)}
      footer={<>
        <button type="button" className="button" onClick={() => setDeleting(null)}>取消</button>
        <button type="button" className="button primary" disabled={busy} onClick={remove}>删除</button>
      </>}>
      <p className="sheet-text">确定删除「{deleting.name}」吗？{deleting.bookCount > 0 ? `里面的 ${deleting.bookCount} 本书会留在书架，只是不再属于这个分组。` : '这个分组里没有书。'}</p>
    </Sheet>}
  </div>;
}
