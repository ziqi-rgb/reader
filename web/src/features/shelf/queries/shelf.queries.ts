import { queryOptions, useQuery } from '@tanstack/react-query';
import type { AppRuntime } from '../../../app/runtime.ts';
import { useRuntime } from '../../../app/providers/runtime-context.tsx';
import type { GroupMode, ReadingState } from '../../../api/types.ts';

/**
 * What narrows the shelf besides the search: 在读 / 想读 / 已读, and the reader's own
 * groups combined by 或 / 与 / 非.
 *
 * Series and tags are deliberately *not* filters here: they come out of the file, so
 * "filter by 分组" meant "filter by whatever the epub happened to carry" — and a
 * rescan could change it under the reader. Groups live in their own table, are per
 * account, and one book may sit in several.
 */
export interface ShelfFilters { status?: ReadingState; groups?: string[]; groupMode?: GroupMode }

export function shelfQuery(runtime: AppRuntime, page = 1, sort: 'recent' | 'added' | 'title' | 'author' = 'recent', search = '', filters: ShelfFilters = {}) {
  const apiSort = sort === 'recent' ? 'updated' : sort;
  const groups = filters.groups ?? [];
  return queryOptions({
    queryKey: ['shelf', runtime.api.baseUrl, runtime.api.currentSession()?.user.id, page, sort, search, filters.status ?? '', groups.join(','), filters.groupMode ?? ''],
    queryFn: ({ signal }) => runtime.api.listBooks({
      scope: 'shelf', page, pageSize: 60, sort: apiSort, order: sort === 'title' || sort === 'author' ? 'asc' : 'desc', search: search.trim(),
      ...(filters.status ? { status: filters.status } : {}),
      ...(groups.length > 0 ? { groups: groups.join(','), groupMode: filters.groupMode ?? 'or' } : {}),
    }, { signal }),
  });
}

export function useShelf(page = 1, sort: 'recent' | 'added' | 'title' | 'author' = 'recent', search = '', filters: ShelfFilters = {}) {
  return useQuery(shelfQuery(useRuntime(), page, sort, search, filters));
}

/**
 * The reader's own groups: the choices behind 分组, and what the management screen
 * renames or deletes.
 */
export function useBookGroups(enabled = true) {
  const runtime = useRuntime();
  return useQuery({
    queryKey: ['book-groups', runtime.api.baseUrl, runtime.api.currentSession()?.user.id],
    queryFn: ({ signal }) => runtime.api.bookGroups({ signal }),
    enabled,
  });
}
