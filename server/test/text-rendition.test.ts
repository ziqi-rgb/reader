import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { escapeHtml } from '../src/indexer/formats/text-html.ts';
import { readingChapters, splitChapters } from '../src/indexer/formats/text.ts';

/**
 * The escaping helper is all that is left of the server's TXT rendition.
 *
 * The paragraph split that used to be tested here moved to the client
 * (`web/src/formats/segments.ts`, tested in `web/test/segments.test.ts`), because
 * deciding where a paragraph is is a *reading* decision and not a property of the
 * file. What is left on the server is the one mechanical thing: making a chapter's
 * characters safe to put in a page, for the paths that still need it.
 */
describe('escapeHtml', () => {
  test('escapes the characters that would otherwise rewrite the page', () => {
    assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
    assert.equal(escapeHtml('a & b'), 'a &amp; b');
    assert.equal(escapeHtml(`"'`), '&quot;&#39;');
  });
});

/**
 * A heading-less file is read as one chapter, and that is a statement about the
 * *reading structure*, not about the file: the heading scan still finds nothing,
 * because there is nothing to find.
 */
describe('readingChapters', () => {
  test('publishes one 正文 chapter covering a story with no headings', () => {
    const text = '第一段。\n第二段。\n第三段。';
    assert.equal(splitChapters(text).chapters.length, 0);
    const { chapters, lines } = readingChapters(text);
    assert.equal(chapters.length, 1);
    assert.equal(chapters[0]?.title, '正文');
    // The single chapter is the whole file, line structure included: the client
    // typesets from line breaks, so a range that dropped them would lose the
    // paragraph boundaries the reader sees.
    assert.equal(lines.slice(chapters[0]!.startLine, chapters[0]!.endLine + 1).join('\n'), text);
  });

  test('leaves a text with real headings alone', () => {
    const text = '第一章 起点\n正文\n第二章 风起\n正文';
    const { chapters } = readingChapters(text);
    assert.deepEqual(chapters.map((chapter) => chapter.title), ['第一章 起点', '第二章 风起']);
  });

  test('keeps zero chapters for text with nothing to read', () => {
    // A 「正文」 entry pointing at whitespace is not a chapter, and offering the
    // reader one whose body is empty is worse than offering none.
    assert.equal(readingChapters('   \n\n\t\n').chapters.length, 0);
    assert.equal(readingChapters('').chapters.length, 0);
  });

  test('splits by the reader\'s own heading prefix instead of the built-in patterns', () => {
    const text = '开头\n@@ 一\n正文\n@@ 二\n正文';
    const { chapters } = splitChapters(text, { headingPrefix: '@@' });
    assert.deepEqual(chapters.map((chapter) => [chapter.title, chapter.startLine, chapter.endLine]), [
      ['前言', 0, 0], ['@@ 一', 1, 2], ['@@ 二', 3, 4],
    ]);
    // A prefix the reader typed is literal text, never a pattern.
    assert.equal(splitChapters(text, { headingPrefix: '(a+)+' }).chapters.length, 0);
  });

  test('places a chapter break at the passage the reader selected', () => {
    const text = ['开头一段。', '中间一段。', '新的开始。', '结尾一段。'].join('\n');
    const { chapters, lines } = splitChapters(text, {
      chapterMarks: [{ title: '新的开始。', quote: '新的开始。', prefix: '中间一段。\n', suffix: '\n结尾' }],
    });
    assert.deepEqual(chapters.map((chapter) => chapter.title), ['前言', '新的开始。']);
    // The break is the whole rest of the passage: the chapter it starts runs to the end.
    const last = chapters[1]!;
    assert.equal(lines.slice(last.startLine, last.endLine + 1).join('\n'), '新的开始。\n结尾一段。');
    // A passage that is no longer in the file is dropped, never approximated.
    assert.equal(splitChapters(text, { chapterMarks: [{ title: 'x', quote: '找不到的句子' }] }).chapters.length, 0);
  });

  test('matches a multi-paragraph selection even though the document has no newlines in it', () => {
    const text = ['第一段。', '第二段。', '第三段。'].join('\n');
    const { chapters } = splitChapters(text, { chapterMarks: [{ title: '第一段。第二段。', quote: '第一段。第二段。' }] });
    assert.deepEqual(chapters.map((chapter) => chapter.title), ['第一段。第二段。']);
  });
});
