/**
 * Routing by URL fragment. A fragment route needs no server configuration, so
 * direct visits and refreshes work on static hosting under any path.
 */
import { useSyncExternalStore } from 'react';

export interface Route {
  page: 'start' | 'explore' | 'workspace' | 'compare' | 'assembler' | 'exercises' | 'about';
  /** Path segments after the page name. */
  params: string[];
}

const PAGES = new Set(['explore', 'workspace', 'compare', 'assembler', 'exercises', 'about']);

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter((p) => p !== '').map(decodeURIComponent);
  const page = parts[0];
  if (page && PAGES.has(page)) return { page: page as Route['page'], params: parts.slice(1) };
  return { page: 'start', params: [] };
}

export function href(page: Route['page'], ...params: string[]): string {
  if (page === 'start') return '#/';
  return '#/' + [page, ...params.map(encodeURIComponent)].join('/');
}

export function navigate(page: Route['page'], ...params: string[]): void {
  window.location.hash = href(page, ...params).slice(1);
}

function subscribe(listener: () => void): () => void {
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}

let cachedHash = '';
let cachedRoute: Route = { page: 'start', params: [] };

function snapshot(): Route {
  const hash = window.location.hash;
  if (hash !== cachedHash) {
    cachedHash = hash;
    cachedRoute = parseRoute(hash);
  }
  return cachedRoute;
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, snapshot);
}
