import {
  PAGE_SIZE,
  isDateRangeInverted,
  parseRecordQuery,
  serializeRecordQuery,
} from './utils.js';

function defaultFilters(includeStreamer) {
  return {
    query: '',
    ...(includeStreamer ? { streamer: '' } : {}),
    from: '',
    to: '',
    sort: 'newest',
  };
}

function normalizeFilters(value, includeStreamer) {
  const filters = typeof value === 'string' || value instanceof URLSearchParams
    ? parseRecordQuery(value)
    : parseRecordQuery(serializeRecordQuery(value));
  if (!includeStreamer) delete filters.streamer;
  return filters;
}

export function createListView({ includeStreamer = true } = {}) {
  return {
    filters: defaultFilters(includeStreamer),
    visibleCount: PAGE_SIZE,

    read(search = '') {
      this.filters = normalizeFilters(search, includeStreamer);
      this.visibleCount = PAGE_SIZE;
      return this;
    },

    query() {
      return serializeRecordQuery(this.filters);
    },

    clear() {
      this.filters = defaultFilters(includeStreamer);
      this.resetVisible();
    },

    resetVisible() {
      this.visibleCount = PAGE_SIZE;
    },

    loadMore(total) {
      if (this.rangeInvalid || this.visibleCount >= total) return false;
      this.visibleCount += PAGE_SIZE;
      return true;
    },

    snapshot(scrollY = 0, owner) {
      return {
        ...(owner === undefined ? {} : { owner }),
        filters: normalizeFilters(this.query(), includeStreamer),
        visibleCount: Math.max(PAGE_SIZE, Math.floor(Number(this.visibleCount) || PAGE_SIZE)),
        scrollY: Math.max(0, Number(scrollY) || 0),
      };
    },

    canRestore(snapshot, owner) {
      if (!snapshot || typeof snapshot !== 'object') return false;
      if (owner !== undefined && snapshot.owner !== owner) return false;
      return serializeRecordQuery(normalizeFilters(snapshot.filters, includeStreamer)) === this.query();
    },

    get active() {
      const { query, streamer = '', from, to, sort } = this.filters;
      return Boolean(query || streamer || from || to || sort === 'oldest');
    },

    get rangeInvalid() {
      return isDateRangeInverted(this.filters);
    },
  };
}
