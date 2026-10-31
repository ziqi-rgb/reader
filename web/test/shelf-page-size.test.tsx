// @vitest-environment jsdom
import { act, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../src/shared/ui/render-root.ts';
import { ShelfPageSizeChip } from '../src/features/shelf/components/page-size-picker.tsx';
import { SHELF_PAGE_SIZE_MAX, shelfPageSizeOrDefault } from '../src/store/settings.ts';

/**
 * 「每页 N」 — the shelf's page size.
 *
 * Two things are worth pinning down. The steps are the reader's shortcuts, and the
 * typed field is clamped rather than refused: typing 500 means "as many as you
 * can", and the server would clamp it anyway — a rejected dialog would just be a
 * second place to learn the same limit. And every change goes through `onChange`,
 * which is what persists it *per device* (the shelf's settings are the screen's,
 * not the account's).
 */

const root = document.createElement('div');
document.body.append(root);

function Harness({ initial, onPick }: { initial: number; onPick(next: number): void }) {
  const [value, setValue] = useState(initial);
  return <ShelfPageSizeChip value={value} onChange={next => { onPick(next); setValue(next); }} />;
}

const paint = (initial: number, onPick: (next: number) => void) => act(() => render(<Harness initial={initial} onPick={onPick} />, root));
const chip = (label: string) => [...root.querySelectorAll<HTMLButtonElement>('button')]
  .find(button => (button.getAttribute('aria-label') ?? button.textContent ?? '') === label);
const button = (text: string) => [...root.querySelectorAll<HTMLButtonElement>('button')]
  .find(button => button.textContent === text);

afterEach(() => act(() => render(null, root)));

it('shows the current size and takes a step from the menu', () => {
  const onPick = vi.fn();
  paint(60, onPick);
  expect(root.textContent).toContain('每页 60');

  act(() => { chip('每页 60 本，点按修改')!.click(); });
  act(() => { button('30')!.click(); });
  expect(onPick).toHaveBeenCalledWith(30);
  // The sheet closes on a pick: the choice is the whole interaction.
  expect(root.querySelector('#shelf-page-size')).toBeNull();
});

it('takes a typed size, and rounds it', () => {
  const onPick = vi.fn();
  paint(60, onPick);
  act(() => { chip('每页 60 本，点按修改')!.click(); });

  const input = root.querySelector<HTMLInputElement>('#shelf-page-size')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '150');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => { button('确定')!.click(); });
  expect(onPick).toHaveBeenCalledWith(150);
});

it('clamps what the server would refuse instead of rejecting it', () => {
  const onPick = vi.fn();
  paint(60, onPick);
  act(() => { chip('每页 60 本，点按修改')!.click(); });

  const input = root.querySelector<HTMLInputElement>('#shelf-page-size')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '5000');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => { button('确定')!.click(); });
  expect(onPick).toHaveBeenCalledWith(SHELF_PAGE_SIZE_MAX);
});

it('refuses nothing, but has nothing to apply for an empty or zero field', () => {
  const onPick = vi.fn();
  paint(60, onPick);
  act(() => { chip('每页 60 本，点按修改')!.click(); });

  const input = root.querySelector<HTMLInputElement>('#shelf-page-size')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '0');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(button('确定')!.disabled).toBe(true);
  expect(onPick).not.toHaveBeenCalled();
});

it('reads a stored value defensively, because it comes from an older build', () => {
  expect(shelfPageSizeOrDefault(undefined)).toBe(60);
  expect(shelfPageSizeOrDefault('')).toBe(60);
  expect(shelfPageSizeOrDefault('abc')).toBe(60);
  expect(shelfPageSizeOrDefault(0)).toBe(60);
  expect(shelfPageSizeOrDefault('30')).toBe(30);
  expect(shelfPageSizeOrDefault(30.4)).toBe(30);
  expect(shelfPageSizeOrDefault(9999)).toBe(SHELF_PAGE_SIZE_MAX);
});
