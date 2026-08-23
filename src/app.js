import { ChatClient } from './chat.js';
import {
  PLAYER_GESTURE_CONFIG,
  createPlaybackToggleCoordinator,
  createPlayerGestureRecognizer,
  isPlayerGestureBlockedTarget,
} from './player-gestures.js';
import { createListView } from './list-view.js';
import { createPlayerController, INITIAL_PLAYER_SNAPSHOT, PLAYER_RATES } from './player/controller.js';
import {
  RECORD_LIST_URL,
  deriveStreamers,
  filterRecords,
  formatBytes,
  formatDate,
  formatDuration,
  metadataForPath,
  nextThumbnailExtension,
  normalizeRecords,
  orderStreamersByStatus,
  parseRoute,
  probeLive,
  recordPath,
  recordUrl,
  selectLiveStreamers,
  serializeRecordQuery,
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

function storedThemePreference() {
  try {
    return normalizeThemePreference(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

export function registerApp(Alpine) {
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
    recordList: createListView({ includeStreamer: true }),
    channelList: createListView({ includeStreamer: false }),
    listObserver: null,
    latestRecordsObserver: null,
    latestRecordLimit: 8,
    playerShellObserver: null,
    playerShellHeight: 0,
    themePreference: storedThemePreference(),
    themeMedia: null,
    themeMediaHandler: null,
    historyIndex: 0,
    routeRun: 0,
    player: null,
    activeMediaKey: '',
    playerSnapshot: INITIAL_PLAYER_SNAPSHOT,
    playerRates: PLAYER_RATES,
    playerGestures: null,
    playerControlsVisible: true,
    playerGestureFeedback: null,
    playerGestureFeedbackTimer: null,
    playerPlaybackCoordinator: null,
    playerHelpOpen: false,
    settingsOpen: false,
    shareOpen: false,
    shareIncludeTime: true,
    debugOpen: false,
    debugEntries: [],
    debugCount: 0,
    debugFilters: { source: '', level: '', text: '' },
    debugAutoScroll: true,
    debugCopyStatus: '',
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
      this.themeMedia = window.matchMedia('(prefers-color-scheme: dark)');
      this.themeMediaHandler = () => {
        if (this.themePreference === 'system') this.syncTheme();
      };
      if (this.themeMedia.addEventListener) this.themeMedia.addEventListener('change', this.themeMediaHandler);
      else this.themeMedia.addListener?.(this.themeMediaHandler);
      this.syncTheme();

      this.player = createPlayerController({
        video: this.$refs.video,
        container: this.$refs.playerContainer,
        getHls: () => window.Hls,
        storage: localStorage,
        onSnapshot: (snapshot) => {
          this.playerSnapshot = snapshot;
        },
        onDebug: ({ count }) => {
          this.debugCount = count;
          if (this.debugOpen) this.refreshDebug();
        },
      });
      this.playerPlaybackCoordinator = createPlaybackToggleCoordinator({
        getPlayer: () => this.player,
        getSnapshot: () => this.playerSnapshot,
        getMediaKey: () => this.activeMediaKey,
        onFeedback: (action) => this.showPlayerGestureFeedback({
          type: 'playback',
          action,
          label: action === 'play' ? '開始播放' : '已暫停',
        }),
      });
      this.playerGestures = createPlayerGestureRecognizer({
        onMouseSingle: () => {
          if (!this.activeMediaKey) return;
          this.playerControlsVisible = true;
          this.togglePlayback({ showFeedback: true });
        },
        onMouseDouble: () => {
          if (!this.activeMediaKey) return;
          this.playerControlsVisible = true;
          this.player?.toggleFullscreen();
        },
        onTouchSingle: () => {
          if (!this.activeMediaKey) return;
          this.playerControlsVisible = !this.playerControlsVisible;
        },
        onTouchDouble: ({ zone }) => {
          if (!this.activeMediaKey || !this.playerSnapshot.canSeek) return false;
          const delta = zone === 'left' ? -PLAYER_GESTURE_CONFIG.touchSeekSeconds : PLAYER_GESTURE_CONFIG.touchSeekSeconds;
          const handled = this.player?.seek(this.playerSnapshot.currentTime + delta) === true;
          if (handled) {
            this.showPlayerGestureFeedback({
              type: 'seek',
              direction: zone,
              label: delta < 0 ? `倒退 ${Math.abs(delta)} 秒` : `快進 ${delta} 秒`,
            });
          }
          return handled;
        },
      });

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

    setupListObserver() {
      if (typeof IntersectionObserver !== 'function') return;
      this.listObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          if (entry.target === this.$refs.recordsLoadSentinel && this.view === 'records') {
            this.loadMoreList('records');
          } else if (entry.target === this.$refs.channelLoadSentinel && this.view === 'channel') {
            this.loadMoreList('channel');
          }
        }
      }, { rootMargin: '600px 0px' });
      this.refreshListObserver();
    },

    setupPlayerShellObserver() {
      const shell = this.$refs.playerShell;
      if (!shell || typeof ResizeObserver !== 'function') return;
      this.playerShellObserver?.disconnect();
      this.playerShellObserver = new ResizeObserver((entries) => {
        const entry = entries.find(({ target }) => target === shell);
        if (!entry) return;
        const borderBox = Array.isArray(entry.borderBoxSize)
          ? entry.borderBoxSize[0]
          : entry.borderBoxSize;
        const height = Number(borderBox?.blockSize ?? entry.contentRect.height);
        if (Number.isFinite(height) && height > 0) {
          this.playerShellHeight = Math.round(height * 100) / 100;
        }
      });
      this.playerShellObserver.observe(shell);
      const initialHeight = shell.getBoundingClientRect().height;
      if (initialHeight > 0) this.playerShellHeight = Math.round(initialHeight * 100) / 100;
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
      if (this.$refs.recordsLoadSentinel) this.listObserver.observe(this.$refs.recordsLoadSentinel);
      if (this.$refs.channelLoadSentinel) this.listObserver.observe(this.$refs.channelLoadSentinel);
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
      if (parseRoute(location.pathname).view === this.view) this.syncListHistory();
    },

    applyListFilters(view) {
      if (this.view !== view) return;
      this.listContext(view)?.model.resetVisible();
      this.syncListHistory(view);
      Alpine.nextTick(() => this.refreshListObserver());
    },

    clearListFilters(view) {
      this.listContext(view)?.model.clear();
      this.applyListFilters(view);
    },

    loadMoreList(view) {
      const context = this.listContext(view);
      if (context?.model.loadMore(context.total)) this.syncListHistory(view);
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
      await Alpine.nextTick();
      if (routeRun !== this.routeRun || this.activeMediaKey !== key) return;
      this.connectChat(chatChannel);
      if (kind === 'live') await this.player.loadLive(source);
      else await this.player.loadRecord(this.currentRecord, { timecode: new URLSearchParams(location.search).get('t') });
    },

    deactivateMedia() {
      if (this.activeMediaKey || this.playerSnapshot.playerState !== 'idle') this.player?.cleanup();
      Alpine.raw(this.playerGestures)?.reset();
      Alpine.raw(this.playerPlaybackCoordinator)?.cancel();
      this.clearPlayerGestureFeedback();
      this.closePlayerHelp(false);
      Alpine.raw(this.chatClient)?.disconnect();
      this.activeMediaKey = '';
      this.chatClient = null;
      this.chatState = 'closed';
      this.chatMessages = [];
      this.chatViewerCount = 0;
      this.chatDraft = '';
      this.settingsOpen = false;
      this.shareOpen = false;
      this.debugOpen = false;
      this.debugEntries = [];
      this.playerControlsVisible = true;
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

    async retryPlayer() {
      await this.player?.retry();
    },

    togglePlayback({ showFeedback = false, forcePlay = false } = {}) {
      return Alpine.raw(this.playerPlaybackCoordinator)?.toggle({ showFeedback, forcePlay }) ?? false;
    },

    toggleMute() {
      this.player?.setMuted(!this.playerSnapshot.muted);
    },

    changePlayerVolume(event) {
      this.player?.setVolume(Number(event.target.value));
    },

    togglePlayerBoost() {
      this.player?.setBoost(!this.playerSnapshot.boostEnabled);
    },

    changePlayerRate(event) {
      const rate = this.playerRates[Math.round(Number(event.target.value))];
      if (rate !== undefined) this.player?.setPlaybackRate(rate);
    },

    changeAutoCatchUp(event) {
      this.player?.setAutoCatchUp(event.target.checked);
    },

    seekPlayer(event) {
      this.player?.seek(Number(event.target.value));
    },

    playerGestureEvent(event) {
      const shell = event.currentTarget;
      const rect = shell?.getBoundingClientRect?.();
      return {
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        button: event.button,
        clientX: event.clientX,
        clientY: event.clientY,
        isPrimary: event.isPrimary,
        zone: rect && event.clientX < rect.left + rect.width / 2 ? 'left' : 'right',
      };
    },

    handlePlayerPointerDown(event) {
      if (event.pointerType === 'mouse') this.playerControlsVisible = true;
      if (isPlayerGestureBlockedTarget(event.target)) {
        Alpine.raw(this.playerGestures)?.pointerCancel({ pointerId: event.pointerId });
        return;
      }
      Alpine.raw(this.playerGestures)?.pointerDown(this.playerGestureEvent(event));
    },

    handlePlayerPointerMove(event) {
      Alpine.raw(this.playerGestures)?.pointerMove(this.playerGestureEvent(event));
    },

    handlePlayerPointerUp(event) {
      Alpine.raw(this.playerGestures)?.pointerUp(this.playerGestureEvent(event));
    },

    handlePlayerPointerCancel(event) {
      Alpine.raw(this.playerGestures)?.pointerCancel(this.playerGestureEvent(event));
    },

    showPlayerGestureFeedback(feedback) {
      clearTimeout(this.playerGestureFeedbackTimer);
      const current = { ...feedback, id: Date.now() };
      this.playerGestureFeedback = current;
      this.playerGestureFeedbackTimer = setTimeout(() => {
        if (this.playerGestureFeedback?.id === current.id) this.playerGestureFeedback = null;
      }, PLAYER_GESTURE_CONFIG.feedbackDuration);
    },

    clearPlayerGestureFeedback() {
      clearTimeout(this.playerGestureFeedbackTimer);
      this.playerGestureFeedbackTimer = null;
      this.playerGestureFeedback = null;
    },

    toggleShare() {
      this.shareOpen = !this.shareOpen;
      this.settingsOpen = false;
      if (this.shareOpen) this.shareIncludeTime = true;
    },

    toggleSettings() {
      this.settingsOpen = !this.settingsOpen;
      this.shareOpen = false;
      this.playerControlsVisible = true;
    },

    closePlayerPopovers() {
      if (this.playerHelpOpen) {
        this.closePlayerHelp();
        return;
      }
      this.settingsOpen = false;
      this.shareOpen = false;
    },

    openPlayerHelp() {
      this.playerControlsVisible = true;
      this.settingsOpen = false;
      this.shareOpen = false;
      this.playerHelpOpen = true;
      Alpine.nextTick(() => {
        const dialog = this.$refs.playerHelpDialog;
        if (!dialog || dialog.open) return;
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
      });
    },

    closePlayerHelp(restoreFocus = true) {
      const wasOpen = this.playerHelpOpen || this.$refs.playerHelpDialog?.open;
      this.playerHelpOpen = false;
      const dialog = this.$refs.playerHelpDialog;
      if (dialog?.open && typeof dialog.close === 'function') dialog.close();
      else dialog?.removeAttribute?.('open');
      if (!wasOpen || !restoreFocus || !this.activeMediaKey) return;
      Alpine.nextTick(() => {
        this.settingsOpen = true;
        Alpine.nextTick(() => this.$refs.playerHelpTrigger?.focus());
      });
    },

    handlePlayerHelpClosed() {
      this.playerHelpOpen = false;
    },

    async togglePictureInPicture() {
      this.settingsOpen = false;
      await this.player?.togglePictureInPicture();
    },

    async submitShare() {
      await this.player?.share({ includeTime: this.view === 'record' && this.shareIncludeTime });
    },

    toggleDebug() {
      this.debugOpen = !this.debugOpen;
      this.settingsOpen = false;
      if (this.debugOpen) this.refreshDebug();
    },

    refreshDebug() {
      const player = Alpine.raw(this.player);
      if (!player) return;
      this.debugEntries = player.getDebugEntries(this.debugFilters);
      if (this.debugAutoScroll) {
        Alpine.nextTick(() => this.$refs.debugLog?.scrollTo({ top: this.$refs.debugLog.scrollHeight }));
      }
    },

    clearPlayerDebug() {
      Alpine.raw(this.player)?.clearDebug();
      this.refreshDebug();
    },

    async copyPlayerDebug() {
      const json = Alpine.raw(this.player)?.exportDebug();
      if (!json || !navigator.clipboard?.writeText) {
        this.debugCopyStatus = '瀏覽器不支援複製 Debug JSON。';
        return;
      }
      try {
        await navigator.clipboard.writeText(json);
        this.debugCopyStatus = 'Debug JSON 已複製。';
      } catch {
        this.debugCopyStatus = '複製失敗，請稍後再試。';
      }
    },

    handlePlayerShortcut(event) {
      if (!this.activeMediaKey || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.target?.closest?.('input, select, textarea, button, [contenteditable="true"]')) return;
      const key = event.key.toLocaleLowerCase();
      if (event.repeat && [' ', 'k', 'm', 'f'].includes(key)) return;
      if (key === ' ' || key === 'k') {
        event.preventDefault();
        this.togglePlayback();
      } else if (key === 'm') {
        event.preventDefault();
        this.toggleMute();
      } else if (key === 'f') {
        event.preventDefault();
        this.player?.toggleFullscreen();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        this.player?.seek(this.playerSnapshot.currentTime - 5);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        this.player?.seek(this.playerSnapshot.currentTime + 5);
      }
    },

    formatPlayerTime(value) {
      const seconds = Number(value);
      if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
      const whole = Math.floor(seconds);
      const hours = Math.floor(whole / 3600);
      const minutes = Math.floor((whole % 3600) / 60);
      const remainder = whole % 60;
      return hours
        ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
        : `${minutes}:${String(remainder).padStart(2, '0')}`;
    },

    playerTimeLabel() {
      if (this.playerSnapshot.mode === 'live') {
        if (this.playerSnapshot.following && this.playerSnapshot.latency !== null) {
          return `LIVE · 延遲 ${this.playerSnapshot.latency.toFixed(1)} 秒`;
        }
        return `DVR · ${this.formatPlayerTime(this.playerSnapshot.currentTime)}`;
      }
      return `${this.formatPlayerTime(this.playerSnapshot.currentTime)} / ${this.formatPlayerTime(this.playerSnapshot.duration)}`;
    },

    formatDebugPayload(entry) {
      try { return JSON.stringify(entry.payload); } catch { return '[Unserializable]'; }
    },

    fmt(value) {
      if (value === null || value === undefined || value === '') return '—';
      if (Array.isArray(value)) {
        if (!value.length) return '—';
        return value.map(({ start, end }) => `${start.toFixed(2)}–${end.toFixed(2)}`).join(', ');
      }
      if (typeof value === 'object') {
        try { return JSON.stringify(value); } catch { return '[Unserializable]'; }
      }
      return String(value);
    },

    destroy() {
      this.stopProbes();
      this.deactivateMedia();
      this.listObserver?.disconnect();
      this.listObserver = null;
      this.latestRecordsObserver?.disconnect();
      this.latestRecordsObserver = null;
      this.playerShellObserver?.disconnect();
      this.playerShellObserver = null;
      this.playerShellHeight = 0;
      if (this.themeMedia?.removeEventListener) this.themeMedia.removeEventListener('change', this.themeMediaHandler);
      else this.themeMedia?.removeListener?.(this.themeMediaHandler);
      this.themeMedia = null;
      this.themeMediaHandler = null;
      Alpine.raw(this.playerGestures)?.destroy();
      this.playerGestures = null;
      Alpine.raw(this.playerPlaybackCoordinator)?.cancel();
      this.playerPlaybackCoordinator = null;
      this.clearPlayerGestureFeedback();
      this.player?.destroy();
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

    chatStateLabel() {
      return { connecting: '連線中', open: '已連線', error: '連線異常', closed: '已離線' }[this.chatState] || '已離線';
    },

    thumbnailUrl,
    nextThumbnailExtension,
    recordUrl,
    streamerPath,
    recordPath,
    formatDate,
    formatDuration,
    formatBytes,

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
      return this.filteredChannelRecords.slice(0, this.channelList.visibleCount);
    },

    get filteredChannelRecords() {
      if (!this.currentStreamer) return [];
      return filterRecords(this.records, {
        ...this.channelList.filters,
        streamer: this.currentStreamer.name,
      });
    },

    get filteredRecords() {
      return filterRecords(this.records, this.recordList.filters);
    },

    get visibleRecords() {
      return this.filteredRecords.slice(0, this.recordList.visibleCount);
    },

    get chatAvailable() {
      if (this.view === 'record') return this.activeMediaKey === `record:${this.currentRecord?.filename}`;
      return this.view === 'channel' && this.activeMediaKey === `live:${this.currentStreamer?.name}`;
    },
  }));
}
