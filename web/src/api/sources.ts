export interface SourceType {
  extensions?: { pages?: Array<{ id: string; title: string }> };
  id: string; pluginId: string; label: string; version: string; builtin: boolean; capabilities: string[];
  configSchema?: { properties?: Record<string, { type?: string; title?: string; default?: unknown; minimum?: number; maximum?: number; enum?: string[]; enumNames?: string[] }>; required?: string[] };
  credentialKeys?: Array<{ key: string; label: string }>;
}
export interface SourceInstance {
  id: string; pluginId: string; sourceType: string; name: string; enabled: boolean; isDefault?: boolean;
  config?: Record<string, unknown>; descriptor: SourceType | null;
}
export interface SourceEntry {
  latestChapter?: string; sourceName?: string; coverUrl?: string;
  ref: string; title: string; authors?: string[]; description?: string;
  options?: Array<{ id: string; label: string; available?: boolean }>;
  /**
   * The book this entry already became, when it is on this reader's shelf.
   *
   * Matched by `(source instance, entry ref)` on the server. There is deliberately
   * no attempt to recognise "the same novel from another source": entry ids are
   * each site's own, and a title+author guess would quietly point at the wrong book.
   */
  bookId?: string;
}
export interface SourcePage {
  limitReached?: boolean;
  items: SourceEntry[]; navigation?: Array<{ ref: string; title: string }>; nextCursor?: string; title?: string;
  errors?: Array<{ source: string; code: string; message: string }>;
  batch?: { completed: number; total: number };
}
export interface SourceAcquisition {
  kind: 'ready' | 'action-required'; publicationId?: string;
  action?: { label: string; url?: string };
}
export interface SourcePlugin {
  updated?: boolean; previousVersion?: string;
  extensions?: { pages?: Array<{ id: string; title: string }> };
  pluginId: string; builtin: boolean; name?: string; version?: string; folder?: string; enabled: boolean;
  runtime?: { state: string } | null; error?: { code: string; message: string };
}
/**
 * 连载状态 as the reader marks it by hand (`null` = 还没有标记).
 *
 * Not inferred from the source: a directory does not say whether a book is
 * finished, and "no new chapters lately" is the same thing whether the book ended
 * or the author is taking a break.
 */
export type SerialStatus = 'ongoing' | 'completed';
/** `unfinished` is 连载中 plus 未标记 — i.e. "hide the ones I am done with". */
export type SerialFilter = 'ongoing' | 'completed' | 'unfinished';
export interface ChapterSubscription {
  bookId: string; title: string; enabled: boolean; intervalMinutes: number;
  serialStatus: SerialStatus | null;
  nextCheckAt: number; lastCheckAt: number | null; lastSuccessAt: number | null;
  lastError: string | null; newChapters: number;
  /** The reader's own groups this book is filed into, for the row's 分组 labels. */
  groups?: Array<{ id: string; name: string }>;
}

export interface ExtensionField {
  dependsOn?: string;
  changeAction?: string;
  placeholder?: string; min?: number; max?: number;
  key: string; label: string; type: 'text' | 'password' | 'textarea' | 'number' | 'boolean' | 'select' | 'file'; required?: boolean;
  value?: string | number | boolean; options?: Array<{ value: string; label: string; parentValues?: string[] }>;
}
export interface ExtensionForm {
  layout?: 'inline'; confirm?: string; id: string; title: string; submit: string; fields: ExtensionField[]; values?: Record<string, unknown> }
export interface ExtensionContent {
  loadAction?: string;
  layout?: 'workbench';
  links?: Array<{ title: string; url: string }>;
  forms: ExtensionForm[];
  outputs?: Array<{ title: string; text: string; format: 'text' | 'log' | 'json' }>;
  sections?: Array<{ title: string; emptyText?: string; items: Array<{ title: string; description?: string; collapsible?: boolean; selectable?: boolean; key?: string; forms?: ExtensionForm[] }> }>;
}
export interface ExtensionPage extends ExtensionContent {
  title: string; description?: string; notice?: string; noticeKind?: 'info' | 'error'; activeTab?: string;
  tabs?: Array<ExtensionContent & { id: string; title: string; description?: string }>;
}

export interface ChapterQuality { chapterId:string; title:string; latestChapter:string; characters:number; images:number; bytes:number; elapsedMs:number }
export interface CredentialStatus { state:'unknown'|'reachable'|'auth-required'|'verification-required'; checkedAt:number|null; available:boolean; fields:Array<{key:string;label:string;configured:boolean}> }
export interface OpdsCredential { id: string; name: string; createdAt: number; expiresAt: number }
