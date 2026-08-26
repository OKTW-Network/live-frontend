import { createChatComponent } from './components/chat.js';
import { createPlayerComponent } from './components/player.js';
import { createRecordLibraryComponent } from './components/record-library.js';
import {
  RECORD_LIST_URL,
  deriveStreamers,
  formatBytes,
  formatDate,
  formatDuration,
  liveThumbnailUrl,
  metadataForPath,
  nextThumbnailExtension,
  normalizeRecords,
  orderStreamersByStatus,
  parseRoute,
  probeLive,
  recordPath,
  recordUrl,
  streamerPath,
  thumbnailUrl,
} from './utils.js';
import {
  THEME_STORAGE_KEY,
  applyThemePreference,
  normalizeThemePreference,
} from './theme.js';

function ensureMeta(selector, attributes) {
  let element = document.head.querySelector(selector);
  if (!element) {
    element = document.createElement('meta');
    Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, value));
    document.head.append(element);
  }
  return element;
}

function applyMetadata(pathname) {
  const metadata = metadataForPath(pathname);
  document.title = metadata.title;
  ensureMeta('meta[name="description"]', { name: 'description' }).setAttribute('content', metadata.description);
  ensureMeta('meta[name="twitter:title"]', { name: 'twitter:title' }).setAttribute('content', metadata.title);
  ensureMeta('meta[name="twitter:description"]', { name: 'twitter:description' }).setAttribute('content', metadata.description);
}

function historyIndexForState(state) {
  const value = state?.onLiveIndex;
  return Number.isInteger(value) ? value : 0;
}

function elementForHash(hash) {
  if (!hash || hash === '#') return null;
  const id = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!id) return null;
  try {
    return document.getElementById(decodeURIComponent(id));
  } catch {
    return null;
  }
}

function storedThemePreference() {
  try {
    return normalizeThemePreference(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

export function registerApp(Alpine) {
  Alpine.data('liveApp', () => {
    const app = {
    loading: true,
    dataError: '',
    view: 'home',
    records: [],
    streamers: [],
    liveStatuses: {},
    currentStreamer: null,
    currentRecord: null,
    notFoundMessage: '',
    themePreference: storedThemePreference(),
    themeMedia: null,
    themeMediaHandler: null,
    historyIndex: 0,
    routeRun: 0,
    activeMediaKey: '',
    probeTimer: null,
    probeRun: 0,
    liveThumbnailVersion: '',
    navigationHandler: null,
    popstateHandler: null,
    visibilityHandler: null,
    beforeUnloadHandler: null,

    async init() {
      this.themeMedia = window.matchMedia('(prefers-color-scheme: dark)');
      this.themeMediaHandler = () => {
        if (this.themePreference === 'system') this.syncTheme();
      };
      this.themeMedia.addEventListener('change', this.themeMediaHandler);
      this.syncTheme();

      this.initPlayer();

      history.scrollRestoration = 'manual';
      this.historyIndex = historyIndexForState(history.state);
      history.replaceState({ ...(history.state || {}), onLiveIndex: this.historyIndex }, '', location.href);

      this.navigationHandler = (event) => this.handleLink(event);
      this.popstateHandler = (event) => {
        this.historyIndex = historyIndexForState(event.state);
        this.transitionToLocation(event.state, { isPop: true });
      };
      this.visibilityHandler = () => {
        if (document.visibilityState === 'hidden') this.stopProbes();
        else if (this.view === 'home') this.startHomeProbes();
        else if (this.view === 'channel' && this.currentStreamer) this.startChannelProbes(this.currentStreamer.name);
      };
      this.beforeUnloadHandler = () => {
        this.saveListViewSnapshot();
        this.destroy();
      };
      document.addEventListener('click', this.navigationHandler);
      document.addEventListener('visibilitychange', this.visibilityHandler);
      window.addEventListener('popstate', this.popstateHandler);
      window.addEventListener('beforeunload', this.beforeUnloadHandler, { once: true });

      await this.loadRecords();
      await this.transitionToLocation(history.state, { initial: true });
      this.setupLatestRecordsObserver();
      this.setupPlayerShellObserver();
      this.setupListObserver();
    },

    syncTheme() {
      applyThemePreference(this.themePreference, {
        prefersDark: this.themeMedia?.matches === true,
      });
    },

    setThemePreference(value) {
      this.themePreference = normalizeThemePreference(value);
      try { localStorage.setItem(THEME_STORAGE_KEY, this.themePreference); } catch { /* optional */ }
      this.syncTheme();
    },

    async loadRecords() {
      this.loading = true;
      this.dataError = '';
      try {
        const response = await fetch(RECORD_LIST_URL, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        this.records = normalizeRecords(await response.json());
        this.streamers = deriveStreamers(this.records);
        if (!this.records.length) this.dataError = '目前沒有可顯示的直播紀錄。';
      } catch {
        this.records = [];
        this.streamers = [];
        this.dataError = '無法讀取直播紀錄，請稍後再試。';
      } finally {
        this.loading = false;
      }
    },

    async retryData() {
      await this.loadRecords();
      await this.resolveLocation(history.state);
    },

    handleLink(event) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target.closest?.('a[href]');
      if (!anchor || anchor.target || anchor.hasAttribute('download')) return;
      const url = new URL(anchor.href, location.href);
      if (url.origin !== location.origin) return;

      const sameDocument = url.pathname === location.pathname && url.search === location.search;
      if (sameDocument && url.hash) {
        event.preventDefault();
        history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
        elementForHash(url.hash)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      if (sameDocument && !url.hash) {
        event.preventDefault();
        return;
      }

      event.preventDefault();
      this.navigate(`${url.pathname}${url.search}${url.hash}`);
    },

    navigate(href, { replace = false } = {}) {
      this.saveListViewSnapshot();
      const url = new URL(href, location.origin);
      if (replace) {
        history.replaceState({ ...(history.state || {}), onLiveIndex: this.historyIndex }, '', `${url.pathname}${url.search}${url.hash}`);
      } else {
        this.historyIndex += 1;
        history.pushState({ onLiveIndex: this.historyIndex }, '', `${url.pathname}${url.search}${url.hash}`);
      }
      this.transitionToLocation(history.state);
    },

    async transitionToLocation(state = history.state, options = {}) {
      const update = async () => {
        await this.resolveLocation(state, options);
        await Alpine.nextTick();
        this.refreshListObserver();
      };

      if (options.initial || typeof document.startViewTransition !== 'function') {
        await update();
        return;
      }

      try {
        const transition = document.startViewTransition(update);
        await transition.updateCallbackDone;
      } catch {
        await update();
      }
    },

    async resolveLocation(state = history.state, { isPop = false } = {}) {
      const run = ++this.routeRun;
      const route = parseRoute(location.pathname);
      this.stopProbes();
      this.notFoundMessage = '';
      this.chatExpanded = false;
      this.nicknamePanelOpen = false;

      if (route.view === 'home') {
        this.deactivateMedia();
        this.currentStreamer = null;
        this.currentRecord = null;
        this.view = 'home';
        applyMetadata(location.pathname);
        this.restorePosition(run, { hash: location.hash });
        this.startHomeProbes();
        return;
      }

      if (route.view === 'records') {
        this.deactivateMedia();
        this.currentStreamer = null;
        this.currentRecord = null;
        this.recordList.read(location.search);
        const snapshot = state?.recordView;
        const canRestore = isPop && this.recordList.canRestore(snapshot);
        if (canRestore) this.recordList.visibleCount = snapshot.visibleCount;
        this.view = 'records';
        applyMetadata(location.pathname);
        this.restorePosition(run, { top: canRestore ? snapshot.scrollY : 0 });
        return;
      }

      if (route.view === 'channel') {
        const streamer = this.streamers.find((item) => item.name === route.streamer);
        if (!streamer) return this.showNotFound('找不到這位主播。', run);
        if (this.activeMediaKey && this.activeMediaKey !== `live:${streamer.name}`) this.deactivateMedia();
        this.currentStreamer = streamer;
        this.currentRecord = null;
        this.channelList.read(location.search);
        const snapshot = state?.channelView;
        const canRestore = isPop && this.channelList.canRestore(snapshot, streamer.name);
        if (canRestore) this.channelList.visibleCount = snapshot.visibleCount;
        this.view = 'channel';
        if (!['online', 'offline'].includes(this.liveStatuses[streamer.name])) {
          this.liveStatuses = { ...this.liveStatuses, [streamer.name]: 'checking' };
        }
        applyMetadata(location.pathname);
        this.restorePosition(run, canRestore ? { top: snapshot.scrollY } : { hash: location.hash });
        this.startChannelProbes(streamer.name);
        return;
      }

      if (route.view === 'record') {
        const record = this.records.find((item) => item.filename === route.filename);
        if (!record) return this.showNotFound('找不到這份直播紀錄。', run);
        if (this.activeMediaKey && this.activeMediaKey !== `record:${record.filename}`) this.deactivateMedia();
        this.currentRecord = record;
        this.currentStreamer = this.streamers.find((item) => item.name === record.streamer) || null;
        this.view = 'record';
        this.posterExt = 'jxl';
        this.posterFailed = false;
        applyMetadata(location.pathname);
        this.restorePosition(run, { top: 0 });
        await this.activateMedia('record', record.filename, record.filename, run);
        return;
      }

      this.showNotFound('這個頁面不存在。', run);
    },

    showNotFound(message, run = ++this.routeRun) {
      this.deactivateMedia();
      this.currentStreamer = null;
      this.currentRecord = null;
      this.view = 'notFound';
      this.notFoundMessage = message;
      applyMetadata(location.pathname);
      this.restorePosition(run, { top: 0 });
    },

    restorePosition(run, { top = 0, hash = '' } = {}) {
      Alpine.nextTick(() => requestAnimationFrame(() => {
        if (run !== this.routeRun) return;
        const target = elementForHash(hash);
        if (target) {
          target.scrollIntoView({ behavior: 'instant', block: 'start' });
          return;
        }
        window.scrollTo({ top, behavior: 'instant' });
      }));
    },

    backFromRecord() {
      if (this.historyIndex > 0) {
        history.back();
        return;
      }
      this.navigate(this.currentStreamer ? streamerPath(this.currentStreamer.name) : '/');
    },

    async startHomeProbes() {
      this.stopProbes();
      if (this.view !== 'home' || document.visibilityState === 'hidden' || !this.streamers.length) return;
      const run = ++this.probeRun;
      const pendingStatuses = { ...this.liveStatuses };
      let hasNewStreamer = false;
      this.streamers.forEach((streamer) => {
        if (['online', 'offline'].includes(pendingStatuses[streamer.name])) return;
        pendingStatuses[streamer.name] = 'checking';
        hasNewStreamer = true;
      });
      if (hasNewStreamer) this.liveStatuses = pendingStatuses;

      const results = await Promise.all(this.streamers.map(async (streamer) => ({
        name: streamer.name,
        status: await probeLive(streamer.name) ? 'online' : 'offline',
      })));
      if (run !== this.probeRun || this.view !== 'home') return;

      const nextStatuses = { ...this.liveStatuses };
      let statusesChanged = false;
      results.forEach(({ name, status }) => {
        if (nextStatuses[name] === status) return;
        nextStatuses[name] = status;
        statusesChanged = true;
      });
      if (statusesChanged) this.liveStatuses = nextStatuses;
      this.liveThumbnailVersion = Date.now();
      if (run === this.probeRun && this.view === 'home') this.probeTimer = setTimeout(() => this.startHomeProbes(), 60000);
    },

    async startChannelProbes(name) {
      this.stopProbes();
      if (this.view !== 'channel' || this.currentStreamer?.name !== name || document.visibilityState === 'hidden') return;
      const run = ++this.probeRun;
      const online = await probeLive(name);
      if (run !== this.probeRun || this.view !== 'channel' || this.currentStreamer?.name !== name) return;
      const nextStatus = online ? 'online' : 'offline';
      if (this.liveStatuses[name] !== nextStatus) {
        this.liveStatuses = { ...this.liveStatuses, [name]: nextStatus };
      }
      if (online && this.activeMediaKey === `live:${name}`) {
        const playerState = this.playerSnapshot.playerState;
        if (playerState === 'offline' || playerState === 'error') await this.player.retry();
      } else if (online) await this.activateMedia('live', name, name, this.routeRun);
      else if (this.activeMediaKey === `live:${name}`) this.deactivateMedia();
      if (run === this.probeRun && this.view === 'channel' && this.currentStreamer?.name === name) {
        this.probeTimer = setTimeout(() => this.startChannelProbes(name), 60000);
      }
    },

    stopProbes() {
      this.probeRun += 1;
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    },

    async activateMedia(kind, source, chatChannel, routeRun = this.routeRun) {
      const key = `${kind}:${source}`;
      if (this.activeMediaKey === key) return;
      this.deactivateMedia();
      this.activeMediaKey = key;
      await Alpine.nextTick();
      if (routeRun !== this.routeRun || this.activeMediaKey !== key) return;
      this.connectChat(chatChannel);
      if (kind === 'live') await this.player.loadLive(source);
      else await this.player.loadRecord(this.currentRecord, { timecode: new URLSearchParams(location.search).get('t') });
    },

    deactivateMedia() {
      this.resetPlayer();
      this.resetChat();
      this.activeMediaKey = '';
    },

    destroy() {
      this.stopProbes();
      this.deactivateMedia();
      this.destroyRecordLibrary();
      this.themeMedia?.removeEventListener('change', this.themeMediaHandler);
      this.themeMedia = null;
      this.themeMediaHandler = null;
      this.destroyPlayer();
      document.removeEventListener('click', this.navigationHandler);
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      window.removeEventListener('popstate', this.popstateHandler);
    },

    statusLabel(name) {
      return { checking: '檢查中', online: '直播中', offline: '目前離線' }[this.liveStatuses[name]] || '尚未檢查';
    },

    statusDotClass(name) {
      return this.liveStatuses[name] === 'online'
        ? 'bg-[var(--live)] live-pulse'
        : this.liveStatuses[name] === 'checking'
          ? 'bg-amber-400'
          : 'bg-[var(--line-strong)]';
    },

    streamerInitial(name) {
      return String(name || '?').trim().slice(0, 2).toLocaleUpperCase('zh-TW');
    },

    thumbnailUrl,
    liveThumbnailUrl,
    nextThumbnailExtension,
    recordUrl,
    streamerPath,
    recordPath,
    formatDate,
    formatDuration,
    formatBytes,

    get liveProbePending() {
      return this.streamers.some((streamer) => !this.liveStatuses[streamer.name] || this.liveStatuses[streamer.name] === 'checking');
    },

    get liveStreamers() {
      return this.streamers.filter((streamer) => this.liveStatuses[streamer.name] === 'online');
    },

    get homeStreamers() {
      return orderStreamersByStatus(this.streamers, this.liveStatuses).slice(0, 12);
    },

    };

    for (const component of [
      createPlayerComponent(Alpine),
      createChatComponent(Alpine),
      createRecordLibraryComponent(Alpine),
    ]) Object.defineProperties(app, Object.getOwnPropertyDescriptors(component));

    return app;
  });
}
