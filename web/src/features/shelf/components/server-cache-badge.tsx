/**
 * The server-cache badge: one circle per book card.
 *
 * Three states, and nothing else:
 *
 *  - **grey disc** — nothing of this book is on the server;
 *  - **grey disc + green ring** — part of it is, the ring showing how much;
 *  - **green disc + white tick** — every chapter is on the server.
 *
 * It deliberately answers only the *server* question (`DATA_DIR/user-cache`).
 * The browser keeps a session copy while reading, but that copy dies with the
 * browser; drawing both in one icon would promise something the reader cannot
 * rely on tomorrow, on another device.
 *
 * A book that only exists as a local file (EPUB/TXT/PDF/CBZ) gets no badge at
 * all: its file already lives on the server, so "downloaded?" has no meaning and
 * a green dot on every such card would say nothing.
 */
export interface CacheProgress {
  /** Chapters already cached on the server, clamped to `total`. */
  cached: number;
  /** Chapters the book has, from the shelf DTO. */
  total: number;
}

export function ServerCacheBadge({ progress }: { progress: CacheProgress }) {
  const total = progress.total;
  const cached = Math.max(0, Math.min(progress.cached, total));
  const done = total > 0 && cached >= total;
  const ratio = total > 0 ? cached / total : 0;
  const label = done ? '已下载到服务器' : ratio > 0 ? `已下载到服务器 ${cached}/${total} 章` : '未下载到服务器';
  // Radius 6 inside a 16-unit box leaves room for the stroke.
  const circumference = 2 * Math.PI * 6;
  return <span className="server-cache-badge" data-done={String(done)} role="img" aria-label={label} title={label}>
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="8" className="server-cache-disc" />
      {!done && ratio > 0 && (
        <circle
          cx="8" cy="8" r="6" fill="none" strokeWidth="2.5" strokeLinecap="round"
          className="server-cache-ring"
          strokeDasharray={`${circumference * ratio} ${circumference}`}
          transform="rotate(-90 8 8)"
        />
      )}
      {done && <path d="M4.4 8.2 6.8 10.6 11.6 5.8" className="server-cache-tick" fill="none" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  </span>;
}
