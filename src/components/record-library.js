import { createListView } from '../list-view.js';
import { filterRecords, serializeRecordQuery, streamerPath } from '../utils.js';

export function createRecordLibraryComponent(Alpine) {
  return {
    recordList: createListView({ includeStreamer: true }),
    channelList: createListView({ includeStreamer: false }),
    listObserver: null,
    latestRecordsObserver: null,
    latestRecordLimit: 8,

    setupListObserver() {
      if (typeof IntersectionObserver !== 'function') return;
      this.listObserver = new IntersectionObserver((entries) => {
        if (!['records', 'channel'].includes(this.view)) return;
        if (entries.some((entry) => entry.isIntersecting && entry.target === this.$refs.recordLoadSentinel)) {
          this.loadMoreList(this.view);
        }
      }, { rootMargin: '600px 0px' });
      this.refreshListObserver();
    },

    setupLatestRecordsObserver() {
      const grid = this.$refs.latestRecordsGrid;
      if (!grid || typeof ResizeObserver !== 'function') return;
      const updateLimit = () => {
        const tracks = getComputedStyle(grid).gridTemplateColumns;
        if (tracks !== 'none') this.latestRecordLimit = Math.max(8, tracks.split(/\s+/).length * 2);
      };
      this.latestRecordsObserver = new ResizeObserver(updateLimit);
      this.latestRecordsObserver.observe(grid);
      updateLimit();
    },

    refreshListObserver() {
      if (!this.listObserver) return;
      this.listObserver.disconnect();
      if (this.$refs.recordLoadSentinel) this.listObserver.observe(this.$refs.recordLoadSentinel);
    },

    destroyRecordLibrary() {
      this.listObserver?.disconnect();
      this.listObserver = null;
      this.latestRecordsObserver?.disconnect();
      this.latestRecordsObserver = null;
    },

    listContext(view = this.view) {
      if (view === 'records') {
        return { model: this.recordList, stateKey: 'recordView', path: '/records', total: this.filteredRecords.length };
      }
      if (view === 'channel' && this.currentStreamer) {
        const owner = this.currentStreamer.name;
        return {
          model: this.channelList,
          stateKey: 'channelView',
          path: streamerPath(owner),
          owner,
          total: this.filteredChannelRecords.length,
        };
      }
      return null;
    },

    syncListHistory(view = this.view) {
      const context = this.listContext(view);
      if (!context) return;
      const snapshot = context.model.snapshot(window.scrollY, context.owner);
      history.replaceState(
        { ...(history.state || {}), onLiveIndex: this.historyIndex, [context.stateKey]: snapshot },
        '',
        `${context.path}${context.model.query()}`,
      );
    },

    saveListViewSnapshot() {
      if (this.listContext()) this.syncListHistory();
    },

    applyListFilters(view = this.view) {
      if (this.view !== view) return;
      this.listContext(view)?.model.resetVisible();
      this.syncListHistory(view);
      Alpine.nextTick(() => this.refreshListObserver());
    },

    clearListFilters(view = this.view) {
      this.listContext(view)?.model.clear();
      this.applyListFilters(view);
    },

    loadMoreList(view = this.view) {
      const context = this.listContext(view);
      if (context?.model.loadMore(context.total)) this.syncListHistory(view);
    },

    allRecordsForCurrentStreamerUrl() {
      if (!this.currentStreamer) return '/records';
      return `/records${serializeRecordQuery({
        streamer: this.currentStreamer.name,
        ...this.channelList.filters,
      })}`;
    },

    get latestRecords() {
      return this.records.slice(0, this.latestRecordLimit);
    },

    get filteredChannelRecords() {
      if (!this.currentStreamer) return [];
      return filterRecords(this.records, { ...this.channelList.filters, streamer: this.currentStreamer.name });
    },

    get filteredRecords() {
      return filterRecords(this.records, this.recordList.filters);
    },

    get activeRecordList() {
      return this.view === 'channel' ? this.channelList : this.recordList;
    },

    get activeFilteredRecords() {
      return this.view === 'channel' ? this.filteredChannelRecords : this.filteredRecords;
    },

    get recordGridRecords() {
      if (this.view === 'home') return this.latestRecords;
      return this.activeFilteredRecords.slice(0, this.activeRecordList.visibleCount);
    },
  };
}
