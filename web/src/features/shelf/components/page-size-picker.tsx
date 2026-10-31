import { useState } from 'react';
import { Sheet } from '../../../ui/sheet.tsx';
import { SHELF_PAGE_SIZES, SHELF_PAGE_SIZE_MAX, shelfPageSizeOrDefault } from '../../../store/settings.ts';

/**
 * 「每页 60」 — how much of the shelf one page shows.
 *
 * A slot is one card, so this is the number of cards a page holds: a 丛书 of 35
 * volumes is one of them, not thirty-five (see `ShelfService.list`). The shelf's
 * default of 60 is a scroll's worth on a phone and barely two rows on a monitor,
 * which is why the reader gets to say.
 *
 * The steps cover "a screenful" and "lean back"; the typed one is there because the
 * right number depends on the screen in front of the reader and no menu can guess
 * it. Text is clamped to what the server accepts (1..200) rather than refused:
 * typing 500 means "as many as you can", not an error to correct.
 */
export function ShelfPageSizeChip({ value, onChange }: {
  value: number;
  onChange(next: number): void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(String(value));

  const openSheet = () => {
    setDraft(String(value));
    setOpen(true);
  };
  const apply = (next: number) => {
    onChange(shelfPageSizeOrDefault(next));
    setOpen(false);
  };
  const typed = Number(draft);
  const typedValid = Number.isFinite(typed) && typed >= 1;

  return <>
    <button type="button" className="chip" aria-haspopup="dialog"
      aria-label={`每页 ${value} 本，点按修改`} onClick={openSheet}>每页 {value}</button>
    {open && <Sheet
      title="每页显示"
      subtitle="书架的格子数；一部丛书算一个格子"
      onClose={() => setOpen(false)}
      footer={<>
        <button type="button" className="button" onClick={() => setOpen(false)}>取消</button>
        <button type="button" className="button primary" disabled={!typedValid}
          onClick={() => apply(typed)}>确定</button>
      </>}>
      <div className="sheet-form">
        <div className="sheet-field">
          <label>档位</label>
          <div className="chip-row" role="group" aria-label="每页档位">
            {SHELF_PAGE_SIZES.map(size => <button key={size} type="button" className="chip"
              aria-pressed={value === size} onClick={() => apply(size)}>{size}</button>)}
          </div>
        </div>
        <div className="sheet-field">
          <label htmlFor="shelf-page-size">自由输入<span className="muted">（1–{SHELF_PAGE_SIZE_MAX}）</span></label>
          <input id="shelf-page-size" type="number" min={1} max={SHELF_PAGE_SIZE_MAX} step={1}
            value={draft} onChange={event => setDraft(event.currentTarget.value)}
            onKeyDown={event => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              if (typedValid) apply(typed);
            }} />
          <p className="sheet-text muted">改完回到第一页，并从下一页起按新档位切页。</p>
        </div>
      </div>
    </Sheet>}
  </>;
}
