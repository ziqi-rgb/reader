import { Button } from '../../../ui/toolkit.tsx';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useRuntime } from '../../../app/providers/runtime-context.tsx';
import { ReaderScreen } from '../../../ui/reader-screen.tsx';
import type { Book } from '../../../api/types.ts';

export function ReaderPage() {
  const runtime = useRuntime();
  const navigate = useNavigate();
  const { bookId = '' } = useParams();
  // A 丛书 chapter tapped in the contents panel names its chapter here, so the
  // new volume opens on that chapter instead of on its stored position.
  const [search] = useSearchParams();
  const section = search.get('section') ?? undefined;
  const host = useRef<HTMLDivElement>(null);
  const [book, setBook] = useState<Book | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    setBook(null); setError(null);
    void runtime.api.getBook(decodeURIComponent(bookId)).then(result => { if (live) setBook(result.book); }).catch(reason => { if (live) setError(reason); });
    return () => { live = false; };
  }, [runtime, bookId]);
  useEffect(() => {
    if (!host.current || !book) return;
    const screen = new ReaderScreen({
      api: runtime.api,
      offline: runtime.offline,
      sync: runtime.sync,
      platform: runtime.platform,
      themeScope: runtime.mediaApi.preferenceScope(),
      settings: runtime.settings.current,
      ...(runtime.pageHost ? { pageHost: runtime.pageHost } : {}),
      ...(runtime.speechBridge ? { speechBridge: runtime.speechBridge } : {}),
      onBack: () => navigate(-1),
      onOpenBook: (id, targetSection) => navigate('/book/' + encodeURIComponent(id) + (targetSection ? '?section=' + encodeURIComponent(targetSection) : ''), { replace: true }),
      onSettingsChange: patch => { void runtime.updateSettings(patch); },
      onSignedOut: () => { void runtime.api.signOut(); },
    });
    host.current.replaceChildren(screen.element);
    // Register the reader's own persistence hook. Calling runtime.flush() here
    // would recurse through runtime.registerReader while the app is flushing.
    const unregister = runtime.registerReader(book, () => screen.flushProgress());
    void screen.open(book, section);
    return () => { unregister(); screen.dispose(); host.current?.replaceChildren(); };
  }, [runtime, book, navigate, section]);
  if (error) return <div className="page-state" role="alert"><h2>无法打开这本书</h2><p>{error instanceof Error ? error.message : '请求失败'}</p><Button onClick={() => navigate(-1)}>返回</Button></div>;
  if (!book) return <div className="page-state" role="status"><div className="spinner" aria-hidden="true" /><p>正在打开书籍…</p></div>;
  return <div ref={host} className="reader-route-host" />;
}


