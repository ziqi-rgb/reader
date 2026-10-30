import { decodeText } from './text-encoding.ts';
import { textToChapterHtml } from './segments.ts';
import type { BookDoc, LoadContext, Section } from './types.ts';

/**
 * Plain-text loader.
 *
 * Three problems worth solving properly, because a TXT library is where a reader
 * either earns trust or loses it:
 *
 * 1. **Encoding.** See text-encoding.ts. This file has no way to know, so it
 *    detects, and it reports what it chose so the UI can let the reader override
 *    it for the one file in a thousand that the heuristic gets wrong.
 *
 * 2. **Chapter splitting.** TXT has no structure at all, so the table of
 *    contents has to be inferred. Getting it wrong in either direction is bad:
 *    too eager and every numbered line becomes a chapter, too timid and a
 *    5000-chapter web novel becomes one endless section that cannot be
 *    navigated or paginated without freezing the device.
 *
 * 3. **A story that has no chapters at all.** Not every book is divided, and a
 *    single-chapter story is a book rather than a failure: it is read as one
 *    chapter called 正文 — the same name the server gives it — instead of being
 *    chopped into arbitrary 「第 N 段」 pieces. Its *navigation* comes from the
 *    reader, who can mark where a chapter begins while reading (see
 *    `TxtChapterMark`).
 */

/**
 * Chapter headings, ordered from most to least specific.
 *
 * Tuned against the shapes that actually appear in Chinese TXT collections:
 * `第一章`, `第 1 章`, `第1节`, `Chapter 3`, and the bracketed forms that
 * scrapers emit. Each alternative is anchored so a line of prose that merely
 * *mentions* a chapter number ("他在第一章里说过") is not mistaken for a
 * heading.
 */
const CHAPTER_PATTERNS: RegExp[] = [
  // 第一章 标题 / 第1章 / 第一百二十三章
  /^\s*第\s*[0-9０-９零一二三四五六七八九十百千万两]+\s*[章回节卷部篇集]\s*[:：.、\-—]?\s*(.{0,60})$/,
  // Chapter 3 / CHAPTER III
  /^\s*chapter\s+([0-9]+|[ivxlcdm]+)\b\s*[:：.、\-—]?\s*(.{0,60})$/i,
  // 【第一章】标题 / （第一节）标题
  /^\s*[【（(\[]\s*第\s*[0-9０-９零一二三四五六七八九十百千万两]+\s*[章回节卷部篇集]\s*[】）)\]]\s*(.{0,60})$/,
  // 卷一 / 卷二 （bare 卷 heading, common in classic novels)
  /^\s*[卷部]\s*[0-9０-９零一二三四五六七八九十百千万两]+\s*(.{0,60})$/,
];

/**
 * A heading line is short. Without this, a paragraph that starts with "第三章"
 * and continues for 800 characters would be treated as a chapter title and the
 * real chapter body would lose its beginning.
 */
const MAX_HEADING_LENGTH = 80;

/**
 * What a file with no headings of its own is called, chapter-wise.
 *
 * Deliberately the same string as the server's `WHOLE_BOOK_TITLE`
 * (`server/src/indexer/formats/text.ts`): the same file read through the
 * windowed path and read through this one has to present the same chapter name,
 * because the reader sees that name in the contents panel, in progress and in
 * search results, and two names for one chapter would mean a position saved
 * online opened somewhere else locally.
 */
const WHOLE_BOOK_TITLE = '正文';

/**
 * A single chapter still needs a ceiling, or one 3MB story has to be laid out in
 * one pass and the phone's UI thread stops responding.
 *
 * Far above anything a chapter normally holds, so an ordinary single-chapter
 * story really is one section — the cap only exists to keep an extreme file
 * readable at all, and a chunked one says so in its label.
 */
const WHOLE_BOOK_CHUNK = 400_000;

/**
 * A chapter break the reader placed themselves.
 *
 * Stored as the selected text rather than as an offset: the selection was made
 * against the rendered document, and the offsets of that document change the
 * moment a break is added, so an offset would point into a different paragraph
 * next time the book opens. The quote is found in the file's own characters.
 */
export interface TxtChapterMark {
  /** Identifier of the stored mark, when it has one; not used for splitting. */
  id?: string;
  /** Heading to show for the chapter this break starts. */
  title: string;
  /** The passage the reader selected; where the chapter begins. */
  quote: string;
  /** Context before the quote, used to tell two identical passages apart. */
  prefix?: string;
  /** Context after the quote. */
  suffix?: string;
}

export interface TxtOptions {
  /** Literal heading prefix; bounded lines avoid untrusted regular expressions. */
  headingPrefix?: string;
  /** Chapter breaks the reader placed by hand. */
  chapterMarks?: readonly TxtChapterMark[];
  /** Force an encoding label such as `gb18030`; detected when omitted. */
  encoding?: string;
  /** Split into chapters. When false the whole book is one section. */
  splitChapters?: boolean;
}

export interface TxtSplitResult {
  doc: BookDoc;
  encoding: string;
  encodingGuessed: boolean;
  chapterCount: number;
}

export function loadTxt(ctx: LoadContext, options: TxtOptions = {}): TxtSplitResult {
  const decoded = options.encoding
    ? { text: decodeWith(ctx.bytes, options.encoding), encoding: options.encoding, guessed: false }
    : decodeText(ctx.bytes);
  const text = normaliseLineEndings(decoded.text);
  const splitChapters = options.splitChapters !== false;

  const found: Array<{ title: string; start: number }> = [];

  if (splitChapters) {
    let offset = 0;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length > 0 && trimmed.length <= MAX_HEADING_LENGTH && (options.headingPrefix ? trimmed.startsWith(options.headingPrefix) : matchHeading(trimmed))) {
        found.push({ title: trimmed, start: offset });
      }
      offset += line.length + 1;
    }
  }

  // The reader's own breaks, which apply even with heading detection switched
  // off: turning off inference says "do not guess", not "ignore what I said".
  found.push(...locateMarks(text, options.chapterMarks ?? []));

  // One ordered list of starts. Two breaks at the same offset are one break;
  // the first title wins, and an inferred heading is pushed first so a mark
  // placed on a heading line keeps the heading's own text.
  found.sort((left, right) => left.start - right.start);
  const chapters: Array<{ title: string; start: number }> = [];
  for (const entry of found) {
    if (chapters[chapters.length - 1]?.start !== entry.start) chapters.push(entry);
  }

  const sections: Section[] = [];
  if (chapters.length === 0) {
    // No headings and no marks: the whole file is one chapter. Not a guess —
    // the file has exactly one chapter, and saying so is the only honest
    // description of it.
    sections.push(...wholeBookSections(text));
  } else {
    if (chapters[0]!.start > 0) {
      const preface = text.slice(0, chapters[0]!.start).trim();
      if (preface.length > 0) {
        sections.push({ id: 'preface', label: '前言', html: textToChapterHtml(preface), depth: 0 });
      }
    }
    for (let index = 0; index < chapters.length; index += 1) {
      const current = chapters[index]!;
      const next = chapters[index + 1];
      const body = text.slice(current.start, next ? next.start : text.length);
      // A chapter of several hundred thousand characters (some web novels have
      // them) still needs splitting, or layout blocks the UI thread.
      const parts = chunkByLength(body, 60_000);
      for (const [partIndex, part] of parts.entries()) {
        sections.push({
          id: `ch${index}-${partIndex}`,
          label: parts.length > 1 ? `${current.title} (${partIndex + 1}/${parts.length})` : current.title,
          html: textToChapterHtml(part.text),
          depth: 0,
        });
      }
    }
  }

  const toc = sections.map((section) => ({ id: section.id, label: section.label, depth: 0 }));

  return {
    encoding: decoded.encoding,
    encodingGuessed: decoded.guessed,
    chapterCount: chapters.length,
    doc: {
      format: 'txt',
      layout: 'reflowable',
      render: 'reflowable',
      direction: 'ltr',
      sections,
      toc,
      styles: [],
      resources: new Map(),
      orderedByBook: chapters.length > 0,
    },
  };
}

/** The whole file as one chapter, chunked only if it is extreme. */
function wholeBookSections(text: string): Section[] {
  const parts = chunkByLength(text, WHOLE_BOOK_CHUNK);
  return parts.map((part, index) => ({
    // Ids stay in the `chunk-` namespace a position saved before this change
    // already uses, so a reader who was in the middle of the story stays there.
    id: `chunk-${index}`,
    label: parts.length > 1 ? `${WHOLE_BOOK_TITLE} (${index + 1}/${parts.length})` : WHOLE_BOOK_TITLE,
    html: textToChapterHtml(part.text),
    depth: 0,
  }));
}

/**
 * Where each mark's chapter begins, as a character offset into the file.
 *
 * A mark that cannot be found is dropped: the text it named is no longer in the
 * file (the book was replaced, or the reader's client picked up a different
 * edition), and a break at a guessed position would cut the story somewhere the
 * reader never asked for.
 */
function locateMarks(text: string, marks: readonly TxtChapterMark[]): Array<{ title: string; start: number }> {
  const located: Array<{ title: string; start: number }> = [];
  for (const mark of marks) {
    const quote = mark.quote?.trim() ?? '';
    if (!quote) continue;
    const at = locateQuote(text, quote);
    if (at < 0) continue;
    // A chapter starts at the beginning of a line, not mid-sentence: the reader
    // selected a passage that begins inside a paragraph, and cutting there would
    // leave that paragraph's opening behind in the previous chapter.
    located.push({ title: headingFor(mark), start: lineStart(text, at) });
  }
  return located;
}

/**
 * The offset of `quote` in `text`, tolerating the difference between a rendered
 * selection and the file.
 *
 * The quote comes from the reader's document, where paragraphs are separated by
 * elements and not by newlines, so a selection spanning two paragraphs does not
 * occur verbatim in the file. It is matched ignoring whitespace, which is also
 * what makes this work for a file whose lines are wrapped anywhere.
 *
 * The probe is the quote's first few characters, and it is what keeps this cheap:
 * a candidate is found with `indexOf` and verified from there, so an ordinary
 * single occurrence costs one scan of the file. Shorter probes are only tried
 * when a longer one finds nothing at all — which happens when the file happens to
 * break a line inside the probe itself.
 */
function locateQuote(text: string, quote: string): number {
  const needle = quote.replace(/\s+/g, '');
  if (!needle) return -1;
  for (let width = Math.min(4, needle.length); width >= 1; width -= 1) {
    const probe = needle.slice(0, width);
    let from = text.indexOf(probe);
    while (from >= 0) {
      if (matchesIgnoringWhitespace(text, from, needle)) return from;
      from = text.indexOf(probe, from + 1);
    }
  }
  return -1;
}

function matchesIgnoringWhitespace(text: string, start: number, needle: string): boolean {
  let matched = 0;
  for (let index = start; index < text.length && matched < needle.length; index += 1) {
    const character = text[index]!;
    if (/\s/.test(character)) continue;
    if (character !== needle[matched]) return false;
    matched += 1;
  }
  return matched === needle.length;
}

function lineStart(text: string, offset: number): number {
  return text.lastIndexOf('\n', offset - 1) + 1;
}

/**
 * A mark's own title, or one derived from the passage it points at.
 *
 * Capped like a heading: a section label is drawn in a contents panel, and the
 * reader's selection can be a paragraph long.
 */
function headingFor(mark: TxtChapterMark): string {
  const title = (mark.title ?? '').replace(/\s+/g, ' ').trim();
  if (title) return title.slice(0, 60);
  return (mark.quote ?? '').replace(/\s+/g, ' ').trim().slice(0, 30) || '新章节';
}

function matchHeading(line: string): boolean {
  for (const pattern of CHAPTER_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(line)) return true;
  }
  return false;
}

function decodeWith(bytes: Uint8Array, encoding: string): string {
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export function normaliseLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

interface Chunk {
  text: string;
  label: string;
}

/**
 * Splits text into pieces of at most `maxLength` characters, breaking on a
 * paragraph boundary when one is close enough.
 *
 * Breaking mid-paragraph is acceptable; breaking mid-sentence would not be, so
 * the search looks backwards for a blank line first and only then for the end
 * of a paragraph.
 */
export function chunkByLength(text: string, maxLength: number): Chunk[] {
  if (text.length <= maxLength) return [{ text, label: '' }];
  const chunks: Chunk[] = [];
  let start = 0;
  let index = 0;
  while (start < text.length) {
    let end = Math.min(start + maxLength, text.length);
    if (end < text.length) {
      const window = text.slice(start + Math.floor(maxLength * 0.6), end);
      const blank = window.lastIndexOf('\n\n');
      if (blank !== -1) end = start + Math.floor(maxLength * 0.6) + blank + 2;
      else {
        const newline = window.lastIndexOf('\n');
        if (newline !== -1) end = start + Math.floor(maxLength * 0.6) + newline + 1;
      }
    }
    const body = text.slice(start, end);
    if (body.trim().length > 0) chunks.push({ text: body, label: `第 ${index + 1} 段` });
    index += 1;
    start = end;
  }
  return chunks;
}

/**
 * A chapter body as the reader's own paragraph markup.
 *
 * Kept as a named export because the loader has always had one and the name is
 * what the tests look for; the work itself moved to `segments.ts`, which is the
 * single definition of what a paragraph is for a TXT — shared with the server's
 * `chapter-full:` rendition's consumer and with the text reader, so a book cannot
 * be typeset one way locally and another way when it arrives windowed.
 */
export const textToHtml = textToChapterHtml;
