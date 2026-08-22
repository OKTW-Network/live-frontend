import { ChatClient } from './chat.js';
import { createPlayerController } from './player.js';
import {
  PAGE_SIZE,
  RECORD_LIST_URL,
  createRecordViewSnapshot,
  deriveStreamers,
  filterRecords,
  formatBytes,
  formatDate,
  formatDuration,
  formatShortDate,
  mapWithConcurrency,
  metadataForPath,
  nextThumbnailExtension,
  normalizeRecords,
  orderStreamersByStatus,
  parseRecordQuery,
  parseRoute,
  probeLive,
  recordPath,
  recordUrl,
  recordViewSnapshotMatches,
  selectLiveStreamers,
  serializeRecordQuery,
  streamerPath,
  thumbnailUrl,
} from './utils.js';
import './styles.css';

const CDN_SCRIPTS = {
  hls: {
    src: 'https://cdn.jsdelivr.net/npm/hls.js@1.7.1/dist/hls.min.js',
    integrity: 'sha384-X6qxWXYhVZFp6V31bNDBz4eOoPnZloPbOdTcnhnvRJY2+2pDMrO7R4/1mXfJ9VXY',
  },
  alpine: {
    src: 'https://cdn.jsdelivr.net/npm/alpinejs@3.16.2/dist/cdn.min.js',
    integrity: 'sha384-hTDKg8MgHALzleab34+W1b6UpW6tektVmHXleL5Ztz8x2WFIJeaJp6ixjNBjbrDY',
  },
};

function loadScript({ src, integrity }) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.integrity = integrity;
    script.crossOrigin = 'anonymous';
    script.referrerPolicy = 'no-referrer';
    script.addEventListener('load', resolve, { once: true });
    script.addEventListener('error', () => reject(new Error(`Unable to load ${src}`)), { once: true });
    document.head.append(script);
  });
}

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

function registerApp(Alpine) {
  Alpine.data('liveApp', () => ({
    loading: true,
    dataError: '',
    view: 'home',
    records: [],
    streamers: [],
    liveStatuses: {},
    currentStreamer: null,
    currentRecord: null,
    notFoundMessage: '',
    recordFilters: { query: '', streamer: '', sort: 'newest' },
    recordVisibleCount: PAGE_SIZE,
    historyIndex: 0,
    routeRun: 0,
    player: null,
    activeMediaKey: '',
    playerState: 'idle',
    mediaStarted: false,
    posterExt: 'jxl',
    posterFailed: false,
    chatClient: null,
    chatState: 'closed',
    chatMessages: [],
    chatViewerCount: 0,
    chatDraft: '',
    chatExpanded: false,
    nicknamePanelOpen: false,
    nickname: localStorage.getItem('config_nickname') || 'anonymous',
    probeTimer: null,
    probeRun: 0,
    navigationHandler: null,
    popstateHandler: null,
    visibilityHandler: null,
    beforeUnloadHandler: null,

    async init() {
      this.player = createPlayerController({
        getVideo: () => this.$refs.video,
        getHls: () => window.Hls,
        onState: (state) => {
          this.playerState = state;
          if (state === 'playing') this.mediaStarted = true;
        },
      });

      history.scrollRestoration = 'manual';
      this.historyIndex = Number.isInteger(history.state?.oktwIndex) ? history.state.oktwIndex : 0;
      history.replaceState({ ...(history.state || {}), oktwIndex: this.historyIndex }, '', location.href);

      this.navigationHandler = (event) => this.handleLink(event);
      this.popstateHandler = (event) => {
        this.historyIndex = Number.isInteger(event.state?.oktwIndex) ? event.state.oktwIndex : 0;
        this.transitionToLocation(event.state, { isPop: true });
      };
      this.visibilityHandler = () => {
        if (document.visibilityState === 'hidden') this.stopProbes();
        else if (this.view === 'home') this.startHomeProbes();
        else if (this.view === 'channel' && this.currentStreamer) this.startChannelProbes(this.currentStreamer.name);
      };
      this.beforeUnloadHandler = () => {
        this.saveRecordViewSnapshot();
        this.destroy();
      };
      document.addEventListener('click', this.navigationHandler);
      document.addEventListener('visibilitychange', this.visibilityHandler);
      window.addEventListener('popstate', this.popstateHandler);
      window.addEventListener('beforeunload', this.beforeUnloadHandler, { once: true });

      await this.loadRecords();
      await this.transitionToLocation(history.state, { initial: true });
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
        document.querySelector(url.hash)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
      this.saveRecordViewSnapshot();
      const url = new URL(href, location.origin);
      if (replace) {
        history.replaceState({ ...(history.state || {}), oktwIndex: this.historyIndex }, '', `${url.pathname}${url.search}${url.hash}`);
      } else {
        this.historyIndex += 1;
        history.pushState({ oktwIndex: this.historyIndex }, '', `${url.pathname}${url.search}${url.hash}`);
      }
      this.transitionToLocation(history.state);
    },

    async transitionToLocation(state = history.state, options = {}) {
      const update = async () => {
        await this.resolveLocation(state, options);
        await Alpine.nextTick();
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
        this.recordFilters = parseRecordQuery(location.search);
        const snapshot = state?.recordView;
        const canRestore = isPop && recordViewSnapshotMatches(snapshot, this.recordFilters);
        this.recordVisibleCount = canRestore ? snapshot.visibleCount : PAGE_SIZE;
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
        this.view = 'channel';
        if (!['online', 'offline'].includes(this.liveStatuses[streamer.name])) {
          this.liveStatuses = { ...this.liveStatuses, [streamer.name]: 'checking' };
        }
        applyMetadata(location.pathname);
        this.restorePosition(run, { hash: location.hash });
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
        if (hash) {
          const target = document.querySelector(hash);
          if (target) {
            target.scrollIntoView({ behavior: 'instant', block: 'start' });
            return;
          }
        }
        window.scrollTo({ top, behavior: 'instant' });
      }));
    },

    saveRecordViewSnapshot() {
      if (this.view !== 'records' || parseRoute(location.pathname).view !== 'records') return;
      const recordView = createRecordViewSnapshot({
        filters: this.recordFilters,
        visibleCount: this.recordVisibleCount,
        scrollY: window.scrollY,
      });
      history.replaceState(
        { ...(history.state || {}), oktwIndex: this.historyIndex, recordView },
        '',
        `/records${serializeRecordQuery(this.recordFilters)}`,
      );
    },

    applyRecordFilters() {
      if (this.view !== 'records') return;
      this.recordVisibleCount = PAGE_SIZE;
      history.replaceState(
        {
          ...(history.state || {}),
          oktwIndex: this.historyIndex,
          recordView: createRecordViewSnapshot({ filters: this.recordFilters, visibleCount: PAGE_SIZE, scrollY: window.scrollY }),
        },
        '',
        `/records${serializeRecordQuery(this.recordFilters)}`,
      );
    },

    loadMoreRecords() {
      this.recordVisibleCount += PAGE_SIZE;
      this.saveRecordViewSnapshot();
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

      const results = await mapWithConcurrency(this.streamers, 3, async (streamer) => ({
        name: streamer.name,
        status: await probeLive(streamer.name) ? 'online' : 'offline',
      }));
      if (run !== this.probeRun || this.view !== 'home') return;

      const nextStatuses = { ...this.liveStatuses };
      let statusesChanged = false;
      results.forEach(({ name, status }) => {
        if (nextStatuses[name] === status) return;
        nextStatuses[name] = status;
        statusesChanged = true;
      });
      if (statusesChanged) this.liveStatuses = nextStatuses;
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
      if (online) await this.activateMedia('live', name, name, this.routeRun);
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
      this.playerState = 'loading';
      this.mediaStarted = false;
      await Alpine.nextTick();
      if (routeRun !== this.routeRun || this.activeMediaKey !== key) return;
      this.connectChat(chatChannel);
      if (kind === 'live') this.player.loadLive(source);
      else this.player.loadRecord(this.currentRecord);
    },

    deactivateMedia() {
      if (this.activeMediaKey || this.playerState !== 'idle') this.player?.cleanup();
      Alpine.raw(this.chatClient)?.disconnect();
      this.activeMediaKey = '';
      this.chatClient = null;
      this.chatState = 'closed';
      this.chatMessages = [];
      this.chatViewerCount = 0;
      this.chatDraft = '';
      this.playerState = 'idle';
      this.mediaStarted = false;
    },

    connectChat(channel) {
      const client = new ChatClient({
        onState: (state) => { this.chatState = state; },
        onViewerCount: (count) => { this.chatViewerCount = count; },
        onMessages: (messages) => {
          const list = this.$refs.chatList;
          const shouldStick = !list || list.scrollHeight - list.scrollTop - list.clientHeight < 96;
          this.chatMessages = messages;
          if (shouldStick) Alpine.nextTick(() => list?.scrollTo({ top: list.scrollHeight, behavior: 'smooth' }));
        },
      });
      client.connect(channel, this.nickname);
      this.chatClient = client;
    },

    saveNickname() {
      this.nickname = this.nickname.trim() || 'anonymous';
      localStorage.setItem('config_nickname', this.nickname);
      Alpine.raw(this.chatClient)?.setNickname(this.nickname);
      this.nicknamePanelOpen = false;
    },

    sendChat() {
      if (Alpine.raw(this.chatClient)?.sendMessage(this.chatDraft)) this.chatDraft = '';
    },

    retryPlayer() {
      if (this.currentRecord && this.activeMediaKey === `record:${this.currentRecord.filename}`) this.player.loadRecord(this.currentRecord);
      else if (this.currentStreamer && this.activeMediaKey === `live:${this.currentStreamer.name}`) this.player.loadLive(this.currentStreamer.name);
    },

    destroy() {
      this.stopProbes();
      this.deactivateMedia();
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

    playerMessage() {
      return {
        loading: '正在連線影音來源…',
        ready: '已就緒，按下播放即可開始。',
        offline: '目前沒有直播，或串流無法取得。',
        unsupported: '這個瀏覽器不支援 HLS 播放。',
        error: this.currentRecord ? '瀏覽器無法播放這份直播紀錄。' : '影音播放發生錯誤。',
      }[this.playerState] || '';
    },

    chatStateLabel() {
      return { connecting: '連線中', open: '已連線', error: '連線異常', closed: '已離線' }[this.chatState] || '已離線';
    },

    thumbnailUrl,
    nextThumbnailExtension,
    recordUrl,
    streamerPath,
    recordPath,
    formatDate,
    formatShortDate,
    formatDuration,
    formatBytes,

    get latestRecords() {
      return this.records.slice(0, 8);
    },

    get liveProbePending() {
      return this.streamers.some((streamer) => !this.liveStatuses[streamer.name] || this.liveStatuses[streamer.name] === 'checking');
    },

    get liveStreamers() {
      return selectLiveStreamers(this.streamers, this.liveStatuses);
    },

    get homeStreamers() {
      return orderStreamersByStatus(this.streamers, this.liveStatuses).slice(0, 12);
    },

    get channelRecords() {
      if (!this.currentStreamer) return [];
      return this.records.filter((record) => record.streamer === this.currentStreamer.name).slice(0, PAGE_SIZE);
    },

    get filteredRecords() {
      return filterRecords(this.records, this.recordFilters);
    },

    get visibleRecords() {
      return this.filteredRecords.slice(0, this.recordVisibleCount);
    },

    get hasMoreRecords() {
      return this.recordVisibleCount < this.filteredRecords.length;
    },

    get chatAvailable() {
      if (this.view === 'record') return this.activeMediaKey === `record:${this.currentRecord?.filename}`;
      return this.view === 'channel' && this.activeMediaKey === `live:${this.currentStreamer?.name}`;
    },
  }));
}

document.addEventListener('alpine:init', () => registerApp(window.Alpine), { once: true });

try {
  await loadScript(CDN_SCRIPTS.hls);
  await loadScript(CDN_SCRIPTS.alpine);
} catch (error) {
  console.error(error);
  const bootError = document.querySelector('#boot-error');
  if (bootError) bootError.hidden = false;
}
