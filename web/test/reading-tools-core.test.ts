import { applyCorrections } from '../src/ui/reading-overrides.ts';
import { loadTxt } from '../src/formats/txt.ts';
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { parseNavigation } from '../src/formats/navigation.ts';
import { anchorFor, anchorRange, selectedAnchor, encodeAnchor, decodeAnchor, findText, searchableText } from '../src/ui/text-anchor.ts';
import { PublicationCache } from '../src/store/publications.ts';
import { SessionCache } from '../src/store/session-cache.ts';
import { BookTransfer } from '../src/core/book-transfer.ts';
import { MemoryKv, MemoryBlobs } from './helpers/env.ts';
import type { Manifest } from '../src/api/types.ts';
import type { ReaderApi } from '../src/api/client.ts';

describe('navigation and text anchors', () => {
  it('preserves three levels, fragments, entities, and TOC navigation selection', () => {
    expect(parseNavigation('<html><nav><a href="cover">封面</a></nav><nav epub:type="toc"><ol><li><a href="a#top">一 &amp; 二</a><ol><li><a href="a#middle">第二层</a><ol><li><a href="b#end">第三层</a></li></ol></li></ol></li><li><a href="c">尾章</a></li></ol></nav></html>', 'nav')).toEqual([
      { href: 'a#top', title: '一 & 二', depth: 0 }, { href: 'a#middle', title: '第二层', depth: 1 }, { href: 'b#end', title: '第三层', depth: 2 }, { href: 'c', title: '尾章', depth: 0 },
    ]);
    expect(parseNavigation('<ncx><navMap><navPoint><navLabel><text>父</text></navLabel><content src="a#x"/><navPoint><navLabel><text>子</text></navLabel><content src="b#y"/></navPoint></navPoint></navMap></ncx>', 'ncx').map(n => n.depth)).toEqual([0,1]);
  });
  it('locates different occurrences across text nodes and rejects ambiguous moved text', () => {
    const root = document.createElement('div'); root.innerHTML = '<p>开头词语<b>结尾</b></p><p>后面词语结束</p>';
    const hits = findText('s', '章', searchableText(root.innerHTML), '词语');
    expect(hits).toHaveLength(2);
    const first = anchorRange(root, hits[0]!.anchor)!, second = anchorRange(root, hits[1]!.anchor)!;
    expect(first.startContainer).not.toBe(second.startContainer);
    expect(decodeAnchor(encodeAnchor(hits[0]!.anchor))).toEqual(hits[0]!.anchor);
    expect(anchorRange(root, { ...hits[0]!.anchor, start: 90, prefix: '不存在', suffix: '不存在' })).toBeNull();
    const spanning = anchorFor('s', searchableText(root.innerHTML), 2, 6);
    expect(anchorRange(root, spanning)?.toString()).toBe('词语结尾');
  });
  it('captures a browser selection and relocates a unique quote after edits', () => {
    const root = document.createElement('div'); root.innerHTML = '<p>前文<b>选中文字</b>后文</p>'; document.body.append(root);
    const range = document.createRange(); range.selectNodeContents(root.querySelector('b')!);
    const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    const anchor = selectedAnchor(root, 's', selection)!; expect(anchor.quote).toBe('选中文字');
    root.prepend(document.createTextNode('新内容')); expect(anchorRange(root, anchor)?.toString()).toBe('选中文字'); root.remove();
  });
  it('reads mobile shadow selections with re-scoped ranges and backwards handles', () => {
    const host = document.createElement('div'); document.body.append(host);
    const shadow = host.attachShadow({mode:'open'}), root = document.createElement('p');
    root.textContent = '前文选中文字后文'; shadow.append(root);
    const text = root.firstChild!;
    const outside = document.createRange(); outside.selectNode(host);
    const selection = {rangeCount:1,isCollapsed:false,getRangeAt:()=>outside,
      anchorNode:text,anchorOffset:6,focusNode:text,focusOffset:2} as unknown as Selection;
    expect(selectedAnchor(root,'s',selection)?.quote).toBe('选中文字');
    const composed = {...selection,anchorNode:document.body,focusNode:document.body,
      getComposedRanges:()=>[{startContainer:text,startOffset:2,endContainer:text,endOffset:6,collapsed:false}]} as unknown as Selection;
    expect(selectedAnchor(root,'s',composed)?.quote).toBe('选中文字');
    expect(selectedAnchor(root,'s',{...selection,anchorNode:document.body} as Selection)).toBeNull();
    host.remove();
  });
});
describe('scoped quota and offline tasks', () => {
  it('keeps chapter text in the session only and can still clear legacy device caches', async () => {
    const kv = new MemoryKv(), blobs = new MemoryBlobs(), session = new SessionCache('one');
    const cache = new PublicationCache(kv, blobs, 'one', session);
    cache.putSessionResource('a', 'x', new TextEncoder().encode('chapter'));
    expect(new TextDecoder().decode((await cache.resource('a', 'x')) ?? new Uint8Array())).toBe('chapter');
    // Reading never writes the persistent store, so nothing is left behind.
    expect(await cache.entries()).toEqual([]);
    // A copy an older build left on disk is still reported, and can be deleted.
    await blobs.put('reader.publication.resource.v1:one:a:x', new Uint8Array([1, 2, 3]));
    expect((await cache.entries()).map(entry => entry.ref)).toEqual(['x']);
    await cache.removeBook('a');
    expect(await cache.entries()).toEqual([]);
    // Another account sees neither the session copy nor anything else.
    expect(await new PublicationCache(kv, blobs, 'two', new SessionCache('two')).resource('a', 'x')).toBeNull();
  });
  it('caches the selected windows into the browser session and leaves the persistent store alone', async () => {
    const kv = new MemoryKv(), blobs = new MemoryBlobs(), session = new SessionCache('scope');
    const cache = new PublicationCache(kv, blobs, 'scope', session);
    const item = (seq: number) => ({ id: String(seq), seq, title: String(seq), href: 'chapter:' + seq, resourceRef: 'r:' + seq, kind: 'chapter', format: 'html', mediaType: 'text/plain' });
    const content = { revision: 'one', kind: 'text', total: 3, groups: [{ id:'a',seq:0,offset:0,count:1,title:'a' },{ id:'b',seq:1,offset:1,count:2,title:'b' }], items:[item(0)] };
    const manifest = { book:{ id:'b', format:'txt' }, content } as unknown as Manifest;
    const asset = vi.fn(async (_id: string, ref: string) => new NodeBlob([ref]));
    const api = { asset, items: vi.fn(async () => ({ ...content, group: 1, items:[item(1),item(2)] })) } as unknown as ReaderApi;
    const task = new BookTransfer(api, cache, session, manifest, () => {}, { perChapter: true });
    await task.start('session', 2, 3);
    expect(task.state.status).toBe('complete'); expect(asset).toHaveBeenCalledTimes(2);
    // Already in this session: a second run fetches nothing.
    await task.start('session', 2, 3);
    expect(asset).toHaveBeenCalledTimes(2);
    // And "session" means session: nothing survived into the persistent store.
    expect(await new PublicationCache(kv, blobs, 'scope').resource('b', 'r:1')).toBeNull();
    expect(session.bytes('b')).toBeGreaterThan(0);
  });
  it('stops a running transfer without keeping a partial copy', async () => {
    const session = new SessionCache('pause');
    const cache = new PublicationCache(new MemoryKv(),new MemoryBlobs(),'pause',session);
    const manifest = { book:{id:'b',format:'epub'},files:[] } as unknown as Manifest;
    const bookBytes = vi.fn((_id: string,{signal}: {signal:AbortSignal}) => new Promise((_resolve,reject) => signal.addEventListener('abort',()=>reject(signal.reason))));
    const task = new BookTransfer({bookBytes} as unknown as ReaderApi,cache,session,manifest,()=>{});
    const run = task.start('session'); await vi.waitFor(()=>expect(bookBytes).toHaveBeenCalled()); await task.pause(); await run;
    expect(task.state.status).toBe('paused'); expect(session.bytes('b')).toBe(0);
  });
});

it('applies literal corrections safely, supports chained edits, and preserves original source', () => {
 const root = document.createElement('div'); root.innerHTML = '<p>需要纠错的原文</p>';
 const first = anchorFor('xhtml:a',root.textContent!,2,4);
 const second = anchorFor('a','需要修改的原文',2,4);
 expect(applyCorrections(root,'a',{version:1,headingPrefix:'',chapterMarks:[],corrections:[{id:'1',anchor:first,replacement:'修改'},{id:'2',anchor:second,replacement:'<script>文本</script>'}]})).toBe(2);
 expect(root.querySelector('script')).toBeNull(); expect(root.textContent).toContain('<script>文本</script>');
});
it('previews and applies a literal TXT heading prefix without executing regular expressions', () => {
 const bytes = new TextEncoder().encode('前言\n@@ 一\n正文\n@@ 二\n正文');
 const result = loadTxt({bytes,fileName:'a.txt',bookId:'a'},{headingPrefix:'@@'});
 expect(result.doc.toc.map(t => t.label)).toEqual(['前言','@@ 一','@@ 二']);
 expect(loadTxt({bytes,fileName:'a.txt',bookId:'a'},{headingPrefix:'(a+)+'}).chapterCount).toBe(0);
});

it('caches a source novel one chapter at a time so the panel can count them as they land', async () => {
 const cache=new PublicationCache(new MemoryKv(),new MemoryBlobs(),'server');
 const session=new SessionCache('server');
 const content={kind:'reflowable',total:45,revision:'v',groups:[{id:'all',seq:0,offset:0,count:45,title:'全部'}],items:[]};
 const manifest={book:{id:'novel',format:'chapters',title:'小说'},files:[],content} as unknown as Manifest;
 let inFlight=0, peak=0, sentTimeout=0;
 const cacheChapters=vi.fn(async (_id:string,from:number,to:number,options?:{timeoutMs?:number})=>{
   inFlight+=1; peak=Math.max(peak,inFlight);
   sentTimeout=options?.timeoutMs ?? sentTimeout;
   await new Promise(resolve=>setTimeout(resolve,0));
   inFlight-=1;
   return from===41
     ? {total:to-from+1,cached:0,failed:[{title:'41',code:'EMPTY_CHAPTER'}]}
     : {total:to-from+1,cached:1,failed:[]};
 });
 const api={cacheChapters,chapterCache:vi.fn(async()=>({chapters:0,bytes:0,total:45,indexes:[]}))} as unknown as ReaderApi;
 const task=new BookTransfer(api,cache,session,manifest,()=>{});
 await task.start('server',1,45,{timeoutMs:120_000});
 // One chapter per request, so "已缓存 N 章" moves after each of them; the source
 // still sees at most two concurrent calls, the same as a batched request.
 expect(cacheChapters).toHaveBeenCalledTimes(45);
 expect(cacheChapters.mock.calls.every(call=>call[1]===call[2])).toBe(true);
 expect(peak).toBeLessThanOrEqual(2);
 expect(sentTimeout).toBe(120_000);
 expect(task.state.status).toBe('complete');
 expect(task.state.failed).toEqual([{title:'41',code:'EMPTY_CHAPTER'}]);
 expect(task.state.serverChapters).toBe(44);
});
it('asks only for the chapters the server is missing', async () => {
 const cache=new PublicationCache(new MemoryKv(),new MemoryBlobs(),'gaps');
 const session=new SessionCache('gaps');
 const content={kind:'reflowable',total:6,revision:'v',groups:[{id:'all',seq:0,offset:0,count:6,title:'全部'}],items:[]};
 const manifest={book:{id:'novel',format:'chapters',title:'小说'},files:[],content} as unknown as Manifest;
 const cacheChapters=vi.fn(async (_id:string,from:number,to:number)=>({total:to-from+1,cached:to-from+1,failed:[]}));
 // Chapters 1, 2, 3 and 5 are already on the server; only 4 and 6 are missing.
 let indexes=[1,2,3,5];
 const api={cacheChapters,chapterCache:vi.fn(async()=>({chapters:indexes.length,bytes:1,total:6,indexes}))} as unknown as ReaderApi;
 const task=new BookTransfer(api,cache,session,manifest,()=>{});
 await task.start('server',1,6);
 expect(cacheChapters.mock.calls.map(call=>[call[1],call[2]])).toEqual([[4,4],[6,6]]);
 // Everything present: the request loop never runs at all.
 indexes=[1,2,3,4,5,6]; cacheChapters.mockClear();
 await task.start('server',1,6);
 expect(cacheChapters).not.toHaveBeenCalled();
 expect(task.state.message).toContain('已有');
});
it('honours the concurrency and per-chapter delay the reader sets', async () => {
 const cache=new PublicationCache(new MemoryKv(),new MemoryBlobs(),'tuning');
 const session=new SessionCache('tuning');
 const content={kind:'reflowable',total:3,revision:'v',groups:[{id:'all',seq:0,offset:0,count:3,title:'全部'}],items:[]};
 const manifest={book:{id:'novel',format:'chapters',title:'小说'},files:[],content} as unknown as Manifest;
 let inFlight=0, peak=0; const startedAt:number[]=[];
 const cacheChapters=vi.fn(async()=>{
   inFlight+=1; peak=Math.max(peak,inFlight); startedAt.push(Date.now());
   await new Promise(resolve=>setTimeout(resolve,5));
   inFlight-=1;
   return {total:1,cached:1,failed:[]};
 });
 const api={cacheChapters,chapterCache:vi.fn(async()=>({chapters:0,bytes:0,total:3,indexes:[]}))} as unknown as ReaderApi;
 const task=new BookTransfer(api,cache,session,manifest,()=>{});
 await task.start('server',1,3,{concurrency:1,delayMs:40});
 // One worker, and a pause before every chapter after the first: the polite shape
 // for a source that limits bursts.
 expect(peak).toBe(1);
 expect(startedAt[1]!-startedAt[0]!).toBeGreaterThanOrEqual(35);
 expect(startedAt[2]!-startedAt[1]!).toBeGreaterThanOrEqual(35);
 expect(task.state.status).toBe('complete');
});
