// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { ResourceResolver, hydrateResources } from '../src/ui/resources.ts';
import type { Resource } from '../src/formats/types.ts';

/**
 * Local books (and the offline mirror) address their own resources through the
 * client's internal `reader-res:` scheme, and this is what turns one into a URL
 * the browser can draw.
 *
 * The SVG cases below are the ones that used to be missed: `<image>` names its
 * target `xlink:href`, a *namespaced* attribute that neither `[href]` nor
 * `getAttribute('href')` sees, and calibre-written EPUBs wrap every cover and
 * colour plate in exactly that element.
 */

const XLINK = 'http://www.w3.org/1999/xlink';

// jsdom implements no object URLs at all, and the resolver's whole job is to hand
// one back — without this every case below would assert on a `null`.
beforeEach(() => {
  let counter = 0;
  Object.defineProperty(URL, 'createObjectURL', {
    value: () => `blob:probe-${(counter += 1)}`,
    configurable: true,
  });
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, configurable: true });
});

function resolverFor(paths: string[]): ResourceResolver {
  const resources = new Map<string, Resource>();
  for (const path of paths) {
    resources.set(path, {
      path,
      mediaType: 'image/png',
      bytes: async () => new Uint8Array([1, 2, 3]),
    });
  }
  return new ResourceResolver(resources);
}

function parse(html: string): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = html;
  return container;
}

describe('hydrateResources', () => {
  it('resolves an img reference into an object URL', async () => {
    const node = parse('<img src="reader-res:OEBPS/a.png"/>');
    await hydrateResources(node, resolverFor(['OEBPS/a.png']));
    expect(node.querySelector('img')?.getAttribute('src')).toMatch(/^blob:/);
  });

  it('resolves an SVG image xlink:href, which is how a plate is drawn', async () => {
    const node = parse('<svg><image xlink:href="reader-res:OEBPS/a.png"></image></svg>');
    await hydrateResources(node, resolverFor(['OEBPS/a.png']));
    const image = node.querySelector('image');
    expect(image?.getAttributeNS(XLINK, 'href')).toMatch(/^blob:/);
  });

  it('resolves an SVG image plain href as well, so either spelling works', async () => {
    const node = parse('<svg><image href="reader-res:OEBPS/a.png"></image></svg>');
    await hydrateResources(node, resolverFor(['OEBPS/a.png']));
    expect(node.querySelector('image')?.getAttribute('href')).toMatch(/^blob:/);
  });

  it('leaves a reference it does not know alone rather than blanking it', async () => {
    const node = parse('<svg><image xlink:href="reader-res:OEBPS/missing.png"></image></svg>');
    await hydrateResources(node, resolverFor([]));
    expect(node.querySelector('image')?.getAttributeNS(XLINK, 'href')).toBe('reader-res:OEBPS/missing.png');
  });
});
