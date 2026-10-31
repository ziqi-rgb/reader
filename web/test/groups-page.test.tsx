// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '../src/shared/ui/render-root.ts';
import { RuntimeContext } from '../src/app/providers/runtime-context.tsx';

/**
 * 分组管理 draws the shelf tree, and its rows can be folded.
 *
 * The fold is the part worth a test: a row that folds itself away has no handle
 * left to reopen it, and a page that re-renders the subtree anyway looks folded
 * while still being three rows taller than the reader asked for.
 */
const groups = [
  { id: 'g1', name: '小说', level: 1, parentId: null, bookCount: 3, subtreeCount: 9, isDefault: true, kind: 'manual' },
  { id: 'g2', name: '小说.奇幻', level: 2, parentId: 'g1', bookCount: 4, subtreeCount: 6, isDefault: false, kind: 'manual' },
  { id: 'g3', name: '小说.奇幻.剑与魔法', level: 3, parentId: 'g2', bookCount: 2, subtreeCount: 2, isDefault: false, kind: 'manual' },
  { id: 'g4', name: '小说.恐怖', level: 2, parentId: 'g1', bookCount: 1, subtreeCount: 1, isDefault: false, kind: 'manual' },
  { id: 'g5', name: '科幻', level: 1, parentId: null, bookCount: 5, subtreeCount: 5, isDefault: false, kind: 'manual' },
  // 未分组 is a filter, not a group: 分组管理 must not offer it as a row to rename.
  { id: 'unfiled', name: '未分组', level: 1, parentId: null, bookCount: 2, subtreeCount: 2, isDefault: false, kind: 'unfiled' },
];
vi.mock('../src/features/shelf/queries/shelf.queries.ts', () => ({
  useBookGroups: () => ({ data: groups, isPending: false, error: null }),
}));
const { GroupsPage } = await import('../src/features/shelf/pages/GroupsPage.tsx');

const root = document.createElement('div');
document.body.append(root);
const createBookGroup = vi.fn(async (name: string) => ({ id: 'new', name, level: 1, parentId: null, bookCount: 0, subtreeCount: 0, isDefault: false, kind: 'manual' }));
const runtime = { api: { createBookGroup } } as any;
const paint = () => act(() => render(
  <RuntimeContext.Provider value={runtime}>
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter><GroupsPage /></MemoryRouter>
    </QueryClientProvider>
  </RuntimeContext.Provider>, root));
const rowNames = () => [...root.querySelectorAll('.groups-row strong')].map(node => node.textContent);
const fold = (label: string) => act(() => root.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());
afterEach(() => { act(() => render(null, root)); createBookGroup.mockClear(); });

it('draws the tree in order, indented by level', () => {
  paint();
  // 未分组 never appears here: it is a filter on the shelf, not a group to manage.
  expect(rowNames()).toEqual(['小说', '奇幻', '剑与魔法', '恐怖', '科幻']);
  expect([...root.querySelectorAll('.groups-row')].map(row => row.getAttribute('data-level')))
    .toEqual(['1', '2', '3', '2', '1']);
  // The path is what tells two same-named children apart; the leaf names do not repeat it.
  expect([...root.querySelectorAll('.groups-row-path')].map(node => node.textContent))
    .toEqual(['小说.奇幻', '小说.奇幻.剑与魔法', '小说.恐怖']);
});

it('folds and reopens a subtree from the row that owns it', async () => {
  paint();
  await fold('收起「小说」的 2 个子分组');
  expect(rowNames()).toEqual(['小说', '科幻']);
  await fold('展开「小说」的 2 个子分组');
  expect(rowNames()).toEqual(['小说', '奇幻', '剑与魔法', '恐怖', '科幻']);
  // Folding a middle row keeps its siblings, and hides only what is under it.
  await fold('收起「奇幻」的 1 个子分组');
  expect(rowNames()).toEqual(['小说', '奇幻', '恐怖', '科幻']);
});
