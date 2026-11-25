/**
 * The query catalog, and the selection the two run panels share.
 *
 * Fetched **once**. "One REST request discovers every question the service can answer"
 * is the whole point of publishing the library as table 1, so two panels each calling
 * `fetchCatalog()` would quietly make it two requests and undercut the claim.
 *
 * Selection and the filters are shared too, so picking Q44 under Run REST and switching
 * to Run SQL keeps your place and changes only the verb.
 */
import { fetchCatalog } from './catalog.js';

export function createQueryStore() {
  const listeners = new Set();
  const state = {
    entries: [],
    categories: [],
    url: null,
    error: null,
    activeId: null,
    search: '',
    portability: '',
  };

  const notify = () => { for (const fn of listeners) fn(state); };

  return {
    state,
    /** Panels re-render on every change; hidden panes cost nothing to redraw. */
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    get active() { return state.entries.find((q) => q.id === state.activeId) ?? null; },
    select(id) { state.activeId = id; notify(); },
    setFilters({ search, portability }) {
      if (search !== undefined) state.search = search;
      if (portability !== undefined) state.portability = portability;
      notify();
    },
    /** The questions matching the shared filters, in catalog order. */
    matching() {
      const term = state.search.trim().toLowerCase();
      return state.entries.filter((q) =>
        (!state.portability || q.portability === state.portability) &&
        (!term || `${q.id} ${q.question} ${q.tsql}`.toLowerCase().includes(term)));
    },
    async load() {
      try {
        const catalog = await fetchCatalog();
        Object.assign(state, { entries: catalog.entries, categories: catalog.categories, url: catalog.url });
      } catch (e) {
        state.error = e;
      }
      notify();
      return state;
    },
  };
}
