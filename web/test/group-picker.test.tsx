// @vitest-environment jsdom
import { act, useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import { render } from '../src/shared/ui/render-root.ts';
import { GroupPicker } from '../src/features/shelf/components/group-picker.tsx';
import type { BookGroup } from '../src/api/types.ts';

/**
 * The picker shared by 书籍详情 and 丛书详情.
 *
 * The behaviour worth pinning down is the closure: ticking a 四级 tag has to tick
 * the 三级, 二级 and 一级 it hangs off, and clearing a 大类 has to clear everything
 * under it. Both are about the saved set being the set the reader can see — a leaf
 * written on its own would still filter correctly (the server expands downwards)
 * but the chips would then describe something other than the rows.
 */

const group = (id: string, name: string, extra: Partial<BookGroup> = {}): BookGroup => ({
  id,
  name,
  bookCount: 1,
  subtreeCount: 1,
  level: name.split('.').length,
  parentId: null,
  isDefault: false,
  kind: 'manual',
  ...extra,
});

const tree: BookGroup[] = [
  group('g1', '小说', { bookCount: 0, subtreeCount: 3 }),
  group('g2', '小说.奇幻', { level: 2, parentId: 'g1' }),
  group('g3', '小说.奇幻.剑与魔法', { level: 3, parentId: 'g2' }),
  group('g4', '小说.奇幻.剑与魔法.转生', { level: 4, parentId: 'g3' }),
  group('g9', '科幻'),
];

const root = document.createElement('div');
document.body.append(root);

function Harness({ initial = [] as string[] }: { initial?: string[] }) {
  const [selected, setSelected] = useState<string[]>(initial);
  return <GroupPicker groups={tree} selected={selected} onChange={setSelected} />;
}

const paint = (initial: string[] = []) => act(() => render(<Harness initial={initial} />, root));
const button = (label: string) => root.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
const click = (label: string) => act(() => { button(label)!.click(); });

afterEach(() => act(() => render(null, root)));

it('ticks every level above a lower group', () => {
  paint();
  // 二级: 篇幅
  click('小说.奇幻，1 本');
  expect(button('从「小说」移出')).toBeTruthy();

  // 三级 tag, then its 四级 细分 — each step keeps the ones above it ticked.
  click('小说.奇幻.剑与魔法，1 本');
  click('展开「剑与魔法」的 1 个四级标签');
  click('小说.奇幻.剑与魔法.转生，1 本');
  expect(button('从「小说」移出')).toBeTruthy();
  expect(button('小说.奇幻，1 本')?.getAttribute('aria-pressed')).toBe('true');
  expect(button('小说.奇幻.剑与魔法，1 本')?.getAttribute('aria-pressed')).toBe('true');
  expect(button('小说.奇幻.剑与魔法.转生，1 本')?.getAttribute('aria-pressed')).toBe('true');
});

it('closes an older selection upwards when it is read back', () => {
  // A membership that names only the leaf still has to draw its 大类 as ticked,
  // because the set that gets saved is the closure.
  paint(['g4']);
  expect(button('从「小说」移出')).toBeTruthy();
  expect(button('小说.奇幻，1 本')?.getAttribute('aria-pressed')).toBe('true');
});

it('leaves the ancestors ticked when a child is cleared on its own', () => {
  // A chosen 四级 opens its tag on load, so its chip is already on screen.
  paint(['g1', 'g2', 'g3', 'g4']);
  click('小说.奇幻.剑与魔法.转生，1 本');
  expect(button('小说.奇幻.剑与魔法.转生，1 本')?.getAttribute('aria-pressed')).toBe('false');
  expect(button('小说.奇幻.剑与魔法，1 本')?.getAttribute('aria-pressed')).toBe('true');
});

it('clears everything under a top-level group, and nothing else', () => {
  paint(['g1', 'g2', 'g3', 'g4', 'g9']);
  click('从「小说」移出');
  expect(button('归入「小说」')).toBeTruthy();
  expect(button('小说.奇幻，1 本')?.getAttribute('aria-pressed')).toBe('false');
  // The other 大类 is untouched by clearing 小说.
  expect(button('从「科幻」移出')).toBeTruthy();
});
