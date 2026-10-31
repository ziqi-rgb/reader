// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { Book } from '../src/api/types.ts';
import { ServerCacheBadge } from '../src/features/shelf/components/server-cache-badge.tsx';
import { cacheProgressOf, seriesCacheProgress } from '../src/features/shelf/pages/ShelfPage.tsx';

/**
 * The shelf badge answers one question for the reader — "is this on my NAS?" — in
 * three states, and it must never answer it from the browser's own cache.
 */
const markup = (cached: number, total: number) => renderToStaticMarkup(<ServerCacheBadge progress={{ cached, total }} />);

it('draws a plain grey disc when nothing is on the server', () => {
  const html = markup(0, 12);
  expect(html).toContain('server-cache-disc');
  expect(html).not.toContain('server-cache-ring');
  expect(html).not.toContain('server-cache-tick');
  expect(html).toContain('data-done="false"');
  expect(html).toContain('未下载到服务器');
});

it('draws a partial ring while some chapters are on the server', () => {
  const html = markup(3, 12);
  expect(html).toContain('server-cache-ring');
  expect(html).not.toContain('server-cache-tick');
  expect(html).toContain('data-done="false"');
  expect(html).toContain('已下载到服务器 3/12 章');
  // A quarter of the way round: the arc length is the ratio of the circumference.
  const circumference = 2 * Math.PI * 6;
  expect(html).toContain(`stroke-dasharray="${circumference * 0.25} ${circumference}"`);
});

it('draws a green disc with a tick once every chapter is cached', () => {
  for (const [cached, total] of [[12, 12], [13, 12]] as const) {
    const html = markup(cached, total);
    expect(html).toContain('data-done="true"');
    expect(html).toContain('server-cache-tick');
    expect(html).not.toContain('server-cache-ring');
    expect(html).toContain('已下载到服务器');
  }
});

it('only source novels get a badge, and a 丛书 reports its volumes together', () => {
  const novel = (id: string, pageCount: number, format = 'chapters') => ({ id, format, pageCount }) as Book;
  const cache = new Map<string, number>([['a', 3], ['b', 7]]);
  // A local file is already on the server: "downloaded?" has no answer to draw.
  expect(cacheProgressOf(novel('a', 20, 'epub'), cache)).toBeUndefined();
  expect(cacheProgressOf(novel('empty', 0), cache)).toBeUndefined();
  expect(cacheProgressOf(novel('a', 20), cache)).toEqual({ cached: 3, total: 20 });
  // Never more than the book has, even if the server holds strays.
  expect(cacheProgressOf(novel('b', 5), cache)).toEqual({ cached: 5, total: 5 });

  expect(seriesCacheProgress([novel('a', 20), novel('b', 10)], cache)).toEqual({ cached: 10, total: 30 });
  expect(seriesCacheProgress([novel('a', 20, 'epub')], cache)).toBeUndefined();
});
