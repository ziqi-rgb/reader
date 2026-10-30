import sanitize from 'sanitize-html';

/**
 * A chapter's readable characters, for the `txt` files a reader downloads.
 *
 * The cached body is whatever the source said it was: `text/plain` chapters are
 * already characters, and `text/html` chapters are markup whose images have been
 * inlined as data URIs (`richContent`). Neither is a file a reader wants on disk
 * — one has lost its paragraph breaks, the other is a wall of base64 — so the
 * export converts to text once, here, instead of leaving every consumer to
 * decide what "the text" is.
 *
 * Block ends become paragraph breaks and `<br>` becomes a line break *before* the
 * markup is stripped: removing tags first would glue every paragraph together,
 * which is the one thing a chapter file must not do.
 */
export function chapterText(body: string, mediaType: string): string {
  if (!/html/i.test(mediaType)) return body.replace(/\r\n?/g, '\n').trim() + '\n';
  const spaced = body
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|h[1-6]|li|blockquote|pre|tr|dd|dt)>/gi, '\n\n')
    .replace(/<img[^>]*\balt="([^"]*)"[^>]*>/gi, '$1');
  return sanitize(spaced, { allowedTags: [], allowedAttributes: {} })
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n';
}
