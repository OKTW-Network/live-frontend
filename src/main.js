import { ChatClient } from './chat.js';
import { createPlayerController } from './player.js';
import {
  PAGE_SIZE,
  RECORD_LIST_URL,
  decodePathSegment,
  deriveStreamers,
  filterRecords,
  formatBytes,
  formatDate,
  formatDuration,
  formatShortDate,
  livePath,
  mapWithConcurrency,
  metadataForPath,
  nextThumbnailExtension,
  normalizeRecords,
  paginate,
  probeLive,
  recordPath,
  recordUrl,
  streamerPath,
  thumbnailUrl,
} from './utils.js';
import './styles.css';

const CDN_SCRIPTS = {
  navigo: {
    src: 'https://cdn.jsdelivr.net/npm/navigo@8.11.1/lib/navigo.min.js',
    integrity: 'sha384-iMcofI1vagkcmjRIvgjDF547fnAc4QY3QgV43SLM6KEnQqx9SRnP/P8w5fVgDVD+',
  },
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
  ensureMeta('meta[property="og:title"]', { property: 'og:title' }).setAttribute('content', metadata.title);
  ensureMeta('meta[property="og:description"]', { property: 'og:description' }).setAttribute('content', metadata.description);
  ensureMeta('meta[name="twitter:title"]', { name: 'twitter:title' }).setAttribute('content', metadata.title);
  ensureMeta('meta[name="twitter:description"]', { name: 'twitter:description' }).setAttribute('content', metadata.description);
  const imageSelectors = ['meta[property="og:image"]', 'meta[name="twitter:image"]'];
  imageSelectors.forEach((selector, index) => {
    const attribute = index === 0 ? { property: 'og:image' } : { name: 'twitter:image' };
    const element = document.head.querySelector(selector);
    if (metadata.useSiteImage) {
      ensureMeta(selector, attribute).setAttribute('content', `${location.origin}/og.png`);
    } else {
      element?.remove();
    }
  });
}

function registerApp(Alpine) {
  Alpine.data('liveApp', () => ({
    loading: true,
    dataError: '',
    dependencyError: '',
    view: 'home',
    records: [],
    streamers: [],
    liveStatuses: {},
    currentStreamer: null,
    currentRecord: null,
    notFoundMessage: '',
    recordFilters: { query: '', streamer: '', sort: 'newest', page: 1 },
    router: null,
    player: null,
    playerState: 'idle',
    mediaStarted: false,
    posterExt: 'jxl',
    posterFailed: false,
    chatClient: null,
    chatState: 'closed',
    chatMessages: [],
    chatViewerCount: 0,
    chatDraft: '',
    nickname: localStorage.getItem('config_nickname') || 'anonymous',
    probeTimer: null,
    probeRun: 0,
    visibilityHandler: null,

    async init() {
      this.player = createPlayerController({
        getVideo: () => this.$refs.video,
        getHls: () => window.Hls,
        onState: (state) => {
          this.playerState = state;
          if (state === 'playing') this.mediaStarted = true;
        },
      });
      this.visibilityHandler = () => {
        if (this.view !== 'home') return;
        if (document.visibilityState === 'visible') this.startHomeProbes();
        else this.stopHomeProbes();
      };
      document.addEventListener('visibilitychange', this.visibilityHandler);
      window.addEventListener('beforeunload', () => this.destroy(), { once: true });
      await this.loadRecords();
      this.initRouter();
    },

    async loadRecords() {
      this.loading = true;
      this.dataError = '';
      try {
        const response = await fetch(RECORD_LIST_URL, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        this.records = normalizeRecords(await response.json());
        this.streamers = deriveStreamers(this.records);
        if (!this.records.length) this.dataError = '目前沒有可顯示的存檔。';
      } catch {
        this.records = [];
        this.streamers = [];
        this.dataError = '無法讀取存檔清單，請稍後再試。';
      } finally {
        this.loading = false;
      }
    },

    async retryData() {
      await this.loadRecords();
      this.router?.resolve();
    },

    initRouter() {
      this.router = new window.Navigo('/');
      this.router
        .on('/', () => this.showHome())
        .on('/records', (match) => this.showRecords(match))
        .on('/@:streamer', (match) => this.showStreamer(match?.data?.streamer))
        .on('/live/:streamer', (match) => this.showLive(match?.data?.streamer))
        .on('/record/:filename', (match) => this.showRecord(match?.data?.filename))
        .notFound(() => this.showNotFound('這個頁面不存在。'))
        .resolve();
    },

    go(path) {
      this.router?.navigate(path);
    },

    resolveParam(value) {
      if (typeof value !== 'string') return null;
      return decodePathSegment(value) ?? value;
    },

    enterView(view) {
      this.leaveMedia();
      this.view = view;
      this.notFoundMessage = '';
      applyMetadata(location.pathname);
      window.scrollTo({ top: 0, behavior: 'instant' });
    },

    showHome() {
      this.enterView('home');
      this.startHomeProbes();
    },

    showRecords(match) {
      this.enterView('records');
      const params = new URLSearchParams(match?.queryString || location.search);
      this.recordFilters = {
        query: params.get('q') || '',
        streamer: params.get('streamer') || '',
        sort: params.get('sort') === 'oldest' ? 'oldest' : 'newest',
        page: Math.max(1, Number(params.get('page')) || 1),
      };
    },

    showStreamer(value) {
      const name = this.resolveParam(value);
      const streamer = this.streamers.find((item) => item.name === name);
      if (!streamer) return this.showNotFound('找不到這位實況主。');
      this.enterView('streamer');
      this.currentStreamer = streamer;
      this.liveStatuses = { ...this.liveStatuses, [name]: 'checking' };
      this.probeOne(name);
    },

    async showLive(value) {
      const name = this.resolveParam(value);
      const streamer = this.streamers.find((item) => item.name === name);
      if (!streamer) return this.showNotFound('找不到這個直播頻道。');
      this.enterView('player');
      this.currentStreamer = streamer;
      this.currentRecord = null;
      this.playerState = 'loading';
      this.mediaStarted = false;
      await Alpine.nextTick();
      this.connectChat(name);
      this.player.loadLive(name);
    },

    async showRecord(value) {
      const filename = this.resolveParam(value);
      const record = this.records.find((item) => item.filename === filename);
      if (!record) return this.showNotFound('找不到這份存檔。');
      this.enterView('player');
      this.currentRecord = record;
      this.currentStreamer = this.streamers.find((item) => item.name === record.streamer) || null;
      this.playerState = 'loading';
      this.mediaStarted = false;
      this.posterExt = 'jxl';
      this.posterFailed = false;
      await Alpine.nextTick();
      this.connectChat(record.filename);
      this.player.loadRecord(record);
    },

    showNotFound(message) {
      this.enterView('notFound');
      this.notFoundMessage = message;
    },

    leaveMedia() {
      this.stopHomeProbes();
      this.player?.cleanup();
      Alpine.raw(this.chatClient)?.disconnect();
      this.chatClient = null;
      this.chatState = 'closed';
      this.chatMessages = [];
      this.chatViewerCount = 0;
      this.chatDraft = '';
      this.playerState = 'idle';
      this.mediaStarted = false;
    },

    destroy() {
      this.leaveMedia();
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.router?.destroy?.();
    },

    async probeOne(name) {
      const online = await probeLive(name);
      this.liveStatuses = { ...this.liveStatuses, [name]: online ? 'online' : 'offline' };
    },

    async startHomeProbes() {
      this.stopHomeProbes();
      if (this.view !== 'home' || document.visibilityState === 'hidden' || !this.streamers.length) return;
      const run = ++this.probeRun;
      this.liveStatuses = this.streamers.reduce(
        (statuses, streamer) => ({ ...statuses, [streamer.name]: 'checking' }),
        { ...this.liveStatuses },
      );
      await mapWithConcurrency(this.streamers, 3, async (streamer) => {
        const online = await probeLive(streamer.name);
        if (run === this.probeRun) {
          this.liveStatuses = { ...this.liveStatuses, [streamer.name]: online ? 'online' : 'offline' };
        }
      });
      if (run === this.probeRun && this.view === 'home') {
        this.probeTimer = setInterval(() => this.startHomeProbes(), 60000);
      }
    },

    stopHomeProbes() {
      this.probeRun += 1;
      clearInterval(this.probeTimer);
      this.probeTimer = null;
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
    },

    sendChat() {
      if (Alpine.raw(this.chatClient)?.sendMessage(this.chatDraft)) this.chatDraft = '';
    },

    retryPlayer() {
      if (this.currentRecord) this.player.loadRecord(this.currentRecord);
      else if (this.currentStreamer) this.player.loadLive(this.currentStreamer.name);
    },

    applyRecordFilters() {
      this.recordFilters.page = 1;
      this.syncRecordUrl();
    },

    changePage(page) {
      const next = Math.min(this.recordPage.totalPages, Math.max(1, page));
      this.recordFilters.page = next;
      this.syncRecordUrl();
      document.querySelector('#records-grid')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },

    syncRecordUrl() {
      const params = new URLSearchParams();
      if (this.recordFilters.query) params.set('q', this.recordFilters.query);
      if (this.recordFilters.streamer) params.set('streamer', this.recordFilters.streamer);
      if (this.recordFilters.sort === 'oldest') params.set('sort', 'oldest');
      if (this.recordFilters.page > 1) params.set('page', String(this.recordFilters.page));
      history.replaceState({}, '', `/records${params.size ? `?${params}` : ''}`);
    },

    showAllForStreamer(name) {
      this.go(`/records?streamer=${encodeURIComponent(name)}`);
    },

    statusLabel(name) {
      return { checking: '檢查中', online: '直播中', offline: '離線' }[this.liveStatuses[name]] || '尚未檢查';
    },

    statusDotClass(name) {
      return this.liveStatuses[name] === 'online' ? 'bg-[#ff5f45] live-pulse' : this.liveStatuses[name] === 'checking' ? 'bg-amber-400' : 'bg-[var(--line-strong)]';
    },

    playerMessage() {
      return {
        loading: '正在連線影音來源…',
        ready: '已就緒，按下播放即可開始。',
        offline: '目前沒有直播，或串流無法取得。',
        unsupported: '這個瀏覽器不支援 HLS 播放。',
        error: this.currentRecord ? '瀏覽器無法播放這份存檔。' : '影音播放發生錯誤。',
      }[this.playerState] || '';
    },

    chatStateLabel() {
      return { connecting: '連線中', open: '已連線', error: '連線異常', closed: '已離線' }[this.chatState] || '已離線';
    },

    thumbnailUrl,
    nextThumbnailExtension,
    recordUrl,
    streamerPath,
    livePath,
    recordPath,
    formatDate,
    formatShortDate,
    formatDuration,
    formatBytes,

    get latestRecords() {
      return this.records.slice(0, 6);
    },

    get streamerRecords() {
      if (!this.currentStreamer) return [];
      return this.records.filter((record) => record.streamer === this.currentStreamer.name).slice(0, 24);
    },

    get filteredRecords() {
      return filterRecords(this.records, this.recordFilters);
    },

    get recordPage() {
      return paginate(this.filteredRecords, this.recordFilters.page, PAGE_SIZE);
    },
  }));
}

document.addEventListener('alpine:init', () => registerApp(window.Alpine), { once: true });

try {
  await Promise.all([loadScript(CDN_SCRIPTS.navigo), loadScript(CDN_SCRIPTS.hls)]);
  await loadScript(CDN_SCRIPTS.alpine);
} catch (error) {
  console.error(error);
  const bootError = document.querySelector('#boot-error');
  if (bootError) bootError.hidden = false;
}
