// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '../src/shared/ui/render-root.ts';
import { RuntimeContext } from '../src/app/providers/runtime-context.tsx';
import { useSettingsStore } from '../src/shared/stores/settings.store.ts';

/** 书架 (prototypes 2/19): 在读 / 想读 / 已读 and 分组 drive the query and the URL; ⋯ marks a book. */
const shelfCalls: unknown[][] = [];
const book = { id: 'b1', title: '夜航船', author: '示例作者', coverUrl: null, format: 'epub', readingState: 'reading' };
/** What `useShelf` reports; a test can swap in a 丛书 stack. */
let shelfItems: Array<Record<string, unknown>> = [book];
/** Slots vs books: on the shelf a 丛书 is one slot, several books. */
let shelfTotals = { total: 1, bookTotal: 1 };
vi.mock('../src/features/shelf/queries/shelf.queries.ts', () => ({
  useShelf: (...args: unknown[]) => { shelfCalls.push(args); return { data: { items: shelfItems, total: shelfTotals.total, bookTotal: shelfTotals.bookTotal, pageSize: 60 }, isPending: false, error: null }; },
  useBookGroups: () => ({
    data: [
      // 三体 also has a folder group of the same name: the server merges them, so the
      // chip writes both ids into the filter (one condition, OR-ed server-side).
      { id: 'g1', name: '三体', bookCount: 1, subtreeCount: 2, level: 1, parentId: null, isDefault: false, kind: 'manual', folderIds: ['folder:三体'] },
      { id: 'g2', name: '三体.黑暗森林', bookCount: 1, subtreeCount: 1, level: 2, parentId: 'g1', isDefault: false, kind: 'manual' },
    ],
    isPending: false, error: null,
  }),
}));
const { ShelfPage } = await import('../src/features/shelf/pages/ShelfPage.tsx');

const root = document.createElement('div');
document.body.append(root);
if (typeof ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
}
const setReadingStatus = vi.fn(async () => undefined);
const runtime = {
  api: { baseUrl: 'https://reader.example.com', currentSession: () => null, setReadingStatus, coverBytes: async () => new Uint8Array() },
  offline: { progressFor: () => undefined },
  updateSettings: async () => undefined,
} as any;
let location = '';
function Where() { location = useLocation().search; return null; }
const paint = (path: string) => act(() => render(
  <RuntimeContext.Provider value={runtime}>
    <QueryClientProvider client={new QueryClient()}><>
      <MemoryRouter initialEntries={[path]}><Routes><Route path="/shelf" element={<><ShelfPage /><Where /></>} /></Routes></MemoryRouter>
    </></QueryClientProvider>
  </RuntimeContext.Provider>, root));
const click = (text: string) => act(() => [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)!.click());
afterEach(() => { act(() => render(null, root)); shelfCalls.length = 0; setReadingStatus.mockClear(); shelfItems = [book]; shelfTotals = { total: 1, bookTotal: 1 }; });

it('filters by reading state and by groups, keeping both in the URL', async () => {
  paint('/shelf?status=want');
  expect(shelfCalls.at(-1)?.[3]).toEqual({ status: 'want' });
  expect([...root.querySelectorAll('[aria-label="阅读状态"] button')].map(button => [button.textContent, button.getAttribute('aria-pressed')]))
    .toEqual([['全部', 'false'], ['在读', 'false'], ['想读', 'true'], ['已读', 'false']]);
  await click('在读');
  expect(new URLSearchParams(location).get('status')).toBe('reading');
  // 一级组 is folded into the filter row: open it, then one top-level group is the
  // whole section (the server adds every subgroup below it, and the folder group of
  // the same name — both ids go into the filter as one condition).
  await act(() => root.querySelector<HTMLButtonElement>('[aria-label="展开一级组"]')!.click());
  await act(() => root.querySelector<HTMLButtonElement>('[aria-label="三体，2 本"]')!.click());
  expect(Object.fromEntries(new URLSearchParams(location))).toMatchObject({ status: 'reading', groups: 'g1+folder:三体', page: '1' });
  expect(shelfCalls.at(-1)?.[3]).toEqual({ status: 'reading', groups: ['g1+folder:三体'], groupModes: { 2: 'or', 3: 'or', 4: 'or' } });
  // 二级组 lives in the 分组 sheet: pick one and 应用 narrows the section to it.
  await click('分组');
  await act(() => root.querySelector<HTMLButtonElement>('[aria-label="三体.黑暗森林，1 本"]')!.click());
  await click('应用');
  expect(new URLSearchParams(location).get('groups')).toBe('g2');
  expect(shelfCalls.at(-1)?.[3]).toEqual({ status: 'reading', groups: ['g2'], groupModes: { 2: 'or', 3: 'or', 4: 'or' } });
  // The active filter is its own chip; pressing it reopens the picker, where 清除分组 drops it.
  await act(() => root.querySelector<HTMLButtonElement>('.shelf-group-active')!.click());
  await click('清除分组');
  expect(Object.fromEntries(new URLSearchParams(location))).toEqual({ sort: 'recent', page: '1', status: 'reading' });
});

it('saves 书籍详情 through the metadata and group endpoints', async () => {
  const patchBookMetadata = vi.fn(async (id: string, fields: Record<string, unknown>) => ({ ...book, id, ...fields }));
  const setBookGroups = vi.fn(async (id: string) => ({ ...book, id }));
  Object.assign(runtime.api, { patchBookMetadata, setBookGroups });
  paint('/shelf');
  await act(() => root.querySelector('.book-card')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  await click('书籍详情');
  // Renaming the book is a metadata override; picking a group is a membership write.
  // A controlled input needs the native setter, or React's value tracker sees no change.
  const title = root.querySelector<HTMLInputElement>('#book-detail-title')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(title, '夜航船（修订）');
    title.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // 分组 is one level at a time now: the ＋ on a 一级组 files the book into that 大类.
  await act(() => root.querySelector<HTMLButtonElement>('[aria-label="归入「三体」"]')!.click());
  // The save is async (two writes), so the click has to be awaited inside act.
  await act(async () => {
    [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '保存')!.click();
  });
  expect(patchBookMetadata).toHaveBeenCalledWith('b1', { title: '夜航船（修订）' });
  expect(setBookGroups).toHaveBeenCalledWith('b1', ['g1']);
});

it('opens 丛书详情 for a stack and files every volume into the chosen group', async () => {
  const setBookGroups = vi.fn(async (id: string) => ({ ...book, id }));
  Object.assign(runtime.api, { setBookGroups });
  shelfItems = [
    { ...book, id: 'v1', series: '三体', seriesIndex: 1, title: '第一部' },
    { ...book, id: 'v2', series: '三体', seriesIndex: 2, title: '第二部' },
  ];
  paint('/shelf');
  await act(() => root.querySelector('.series-card')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  expect([...root.querySelectorAll('.sheet-list button')].map(button => button.textContent))
    .toEqual(['编辑整组丛书（2 册）', '丛书详情（2 册）', '取消丛书（整组）']);
  await click('丛书详情（2 册）');
  // The 丛书 detail uses the same picker as 书籍详情 (one tree, browsed by 大类),
  // so filing the whole stack goes through the same ＋ on the 一级组.
  await act(() => root.querySelector<HTMLButtonElement>('[aria-label="归入「三体」"]')!.click());
  await act(async () => {
    [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '保存分组')!.click();
  });
  expect(setBookGroups).toHaveBeenCalledTimes(2);
  expect(setBookGroups).toHaveBeenCalledWith('v1', ['g1']);
  expect(setBookGroups).toHaveBeenCalledWith('v2', ['g1']);
});

it('shows a card\'s state and marks it from the context menu', async () => {
  paint('/shelf');
  expect(root.querySelector('.book-state')?.textContent).toBe('在读');
  // The menu lives on the card itself now: right-click (or a long press on touch).
  const openMenu = () => act(() => root.querySelector('.book-card')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  await openMenu();
  const options = [...root.querySelectorAll('.sheet-list button')].map(button => button.textContent);
  expect(options).toEqual(['书籍详情', '标记为想读', '标记为已读', '清除标记', '编辑丛书 / 编号', '从书架拿掉']);
  await click('标记为已读');
  expect(setReadingStatus).toHaveBeenCalledWith('b1', 'finished');
  await openMenu();
  await click('清除标记');
  expect(setReadingStatus).toHaveBeenLastCalledWith('b1', null);
});

it('asks for the page size the reader picked, and remembers it on this device', async () => {
  const updateSettings = vi.fn(async () => undefined);
  runtime.updateSettings = updateSettings;
  paint('/shelf');
  // 60 is the default, so the URL says nothing about it.
  expect(shelfCalls.at(-1)?.[4]).toBe(60);
  expect(root.textContent).toContain('每页 60');
  expect(new URLSearchParams(location).get('pageSize')).toBeNull();

  await act(() => root.querySelector<HTMLButtonElement>('[aria-label="每页 60 本，点按修改"]')!.click());
  await click('30');
  expect(shelfCalls.at(-1)?.[4], 'the query asks for 30 slots').toBe(30);
  expect(Object.fromEntries(new URLSearchParams(location))).toMatchObject({ page: '1', pageSize: '30' });
  // Per device, not per account: the choice goes to the device settings store.
  expect(updateSettings).toHaveBeenCalledWith({ shelfPageSize: 30 });
});

it('lets a shared link set the page size, over the saved one', async () => {
  // A link someone sends carries the page size it was built with; showing the
  // recipient's saved 60 instead would open a page that is not the one promised.
  paint('/shelf?pageSize=20');
  expect(shelfCalls.at(-1)?.[4]).toBe(20);
  expect(root.textContent).toContain('每页 20');
});

it('counts a 丛书 as one book by default, and files when that is turned off', async () => {
  // Six slots behind 55 files: the number has to say what the grid shows, or the
  // reader counts 55 covers and finds six (「丛书算一本」, 偏好 → 书架显示).
  shelfTotals = { total: 6, bookTotal: 55 };
  paint('/shelf');
  expect(root.querySelector('.shelf-count')?.textContent).toBe('共 6 本');

  act(() => useSettingsStore.setState(state => ({ settings: { ...state.settings, shelfCountSeriesAsOne: false } })));
  expect(root.querySelector('.shelf-count')?.textContent).toBe('共 55 本');

  // Back on, so the next test reads the default.
  act(() => useSettingsStore.setState(state => ({ settings: { ...state.settings, shelfCountSeriesAsOne: true } })));
});
