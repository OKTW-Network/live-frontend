import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createPlayerController, LIVE_LATENCY_PROFILES } from '../src/player/controller.js';

class FakeEventTarget extends EventTarget {
  emit(type, detail = {}) {
    this.dispatchEvent(Object.assign(new Event(type), detail));
  }
}

class FakeTimeRanges {
  constructor(ranges = []) { this.ranges = ranges; }
  get length() { return this.ranges.length; }
  start(index) { return this.ranges[index][0]; }
  end(index) { return this.ranges[index][1]; }
}

class FakeVideo extends FakeEventTarget {
  constructor({ nativeHls = false } = {}) {
    super();
    this.nativeHls = nativeHls;
    this.attributes = new Map();
    this.src = '';
    this.currentTime = 0;
    this.duration = Number.NaN;
    this.buffered = new FakeTimeRanges();
    this.seekable = new FakeTimeRanges();
    this.networkState = 0;
    this.readyState = 0;
    this.paused = true;
    this.ended = false;
    this.muted = false;
    this.defaultMuted = false;
    this.volume = 1;
    this.playbackRate = 1;
    this.playCalls = 0;
    this.pauseCalls = 0;
    this.loadCalls = 0;
    this.playResults = [];
    this.rejectedRates = new Set();
    this.parentNode = null;
  }
  canPlayType() { return this.nativeHls ? 'probably' : ''; }
  setAttribute(name, value = '') { this.attributes.set(name, value); }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === 'src') this.src = '';
    if (name === 'crossorigin') this.crossOrigin = null;
  }
  load() { this.loadCalls += 1; }
  pause() { this.pauseCalls += 1; this.paused = true; }
  play() {
    this.playCalls += 1;
    const result = this.playResults.length ? this.playResults.shift() : true;
    if (result instanceof Error) return Promise.reject(result);
    this.paused = false;
    return Promise.resolve(result);
  }
  set playbackRate(value) {
    if (this.rejectedRates?.has(value)) throw new RangeError(`Rejected ${value}`);
    this._playbackRate = value;
  }
  get playbackRate() { return this._playbackRate ?? 1; }
  cloneNode() {
    const clone = new FakeVideo({ nativeHls: this.nativeHls });
    clone.attributes = new Map(this.attributes);
    clone.muted = this.muted;
    clone.defaultMuted = this.defaultMuted;
    clone.volume = this.volume;
    clone.playbackRate = this.playbackRate;
    return clone;
  }
  requestPictureInPicture() { return Promise.resolve(); }
}

class FakeContainer extends FakeEventTarget {
  constructor(video) {
    super();
    this.video = video;
    video.parentNode = this;
    this.fullscreenCalls = 0;
  }
  replaceChild(next, previous) {
    assert.equal(previous, this.video);
    this.video = next;
    next.parentNode = this;
    previous.parentNode = null;
  }
  requestFullscreen() { this.fullscreenCalls += 1; return Promise.resolve(); }
}

class FakeDocument extends FakeEventTarget {
  constructor() {
    super();
    this.visibilityState = 'visible';
    this.pictureInPictureEnabled = true;
    this.pictureInPictureElement = null;
    this.fullscreenEnabled = true;
    this.fullscreenElement = null;
    this.title = 'Test Player';
  }
  exitPictureInPicture() { this.pictureInPictureElement = null; return Promise.resolve(); }
  exitFullscreen() { this.fullscreenElement = null; return Promise.resolve(); }
}

class FakeStorage {
  constructor(values = {}) { this.values = new Map(Object.entries(values)); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
}

class FakeAudioNode {
  constructor() { this.connections = []; this.disconnected = false; }
  connect(node) { this.connections.push(node); return node; }
  disconnect() { this.disconnected = true; }
}

class FakeAudioContext extends FakeEventTarget {
  static instances = [];
  static failResume = false;
  constructor() {
    super();
    this.state = 'suspended';
    this.destination = {};
    this.sources = [];
    this.gains = [];
    FakeAudioContext.instances.push(this);
  }
  createMediaElementSource(video) {
    const node = new FakeAudioNode();
    node.video = video;
    this.sources.push(node);
    return node;
  }
  createGain() {
    const node = new FakeAudioNode();
    node.gain = { value: 1 };
    this.gains.push(node);
    return node;
  }
  resume() {
    if (FakeAudioContext.failResume) return Promise.reject(new Error('resume denied'));
    this.state = 'running';
    this.emit('statechange');
    return Promise.resolve();
  }
  close() { this.state = 'closed'; this.emit('statechange'); return Promise.resolve(); }
}

class FakeHls {
  static Events = {
    MANIFEST_PARSED: 'manifest', BUFFER_APPENDED: 'buffer-appended', ERROR: 'error', LEVEL_LOADED: 'level-loaded',
  };
  static ErrorTypes = { NETWORK_ERROR: 'network', MEDIA_ERROR: 'media' };
  static ErrorDetails = { BUFFER_ADD_CODEC_ERROR: 'bufferAddCodecError' };
  static instances = [];
  static isSupported() { return true; }
  constructor(config) {
    this.config = { ...config };
    this.handlers = new Map();
    this.destroyed = false;
    this.latency = 4;
    this.targetLatency = 3;
    this.liveSyncPosition = 18;
    FakeHls.instances.push(this);
  }
  on(type, handler) {
    const handlers = this.handlers.get(type) || [];
    handlers.push(handler);
    this.handlers.set(type, handlers);
  }
  emit(type, data = {}) { for (const handler of this.handlers.get(type) || []) handler(type, data); }
  loadSource(url) { this.url = url; }
  attachMedia(video) { this.video = video; this.mutedWhenAttached = video.muted; }
  recoverMediaError() { this.recoveryCount = (this.recoveryCount || 0) + 1; }
  destroy() { this.destroyed = true; }
}

function notAllowed(message = 'blocked') {
  return Object.assign(new Error(message), { name: 'NotAllowedError' });
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createHarness({
  nativeHls = false,
  hlsSupported = true,
  storageValues = {},
  fetchResult = { ok: true, body: { cancel: () => Promise.resolve() } },
  AudioContext = FakeAudioContext,
  href = 'http://localhost/watch',
  navigator = {},
} = {}) {
  const video = new FakeVideo({ nativeHls });
  const container = new FakeContainer(video);
  const document = new FakeDocument();
  const storage = new FakeStorage(storageValues);
  const snapshots = [];
  const timer = { callback: null, cleared: false };
  const controller = createPlayerController({
    video,
    container,
    getHls: () => hlsSupported ? FakeHls : { isSupported: () => false },
    storage,
    environment: {
      AudioContext,
      document,
      navigator,
      location: { href },
      fetch: async (...args) => {
        if (typeof fetchResult === 'function') return fetchResult(...args);
        if (fetchResult instanceof Error) throw fetchResult;
        return fetchResult;
      },
      setInterval: (callback) => { timer.callback = callback; return 1; },
      clearInterval: () => { timer.cleared = true; timer.callback = null; },
    },
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  });
  return {
    video, container, document, storage, snapshots, timer, controller,
    get snapshot() { return snapshots.at(-1); },
  };
}

beforeEach(() => {
  FakeAudioContext.instances = [];
  FakeAudioContext.failResume = false;
  FakeHls.instances = [];
});

test('live HLS is muted before attachment and autoplay state follows the play promise', async () => {
  const harness = createHarness();
  const { controller, video } = harness;
  assert.equal(await controller.loadLive('panda'), 'hls');
  const hls = FakeHls.instances[0];
  assert.equal(hls.mutedWhenAttached, true);
  assert.deepEqual(
    Object.fromEntries(Object.keys(LIVE_LATENCY_PROFILES.low).map((key) => [key, hls.config[key]])),
    LIVE_LATENCY_PROFILES.low,
  );
  assert.equal(hls.config.startPosition, -1);
  assert.equal(hls.config.liveSyncMode, 'buffered');
  assert.deepEqual([...hls.handlers.keys()].sort(), ['buffer-appended', 'error', 'manifest']);
  assert.equal(video.playCalls, 0);

  hls.emit(FakeHls.Events.MANIFEST_PARSED);
  await flush();
  assert.equal(video.playCalls, 1);
  assert.equal(harness.snapshot.autoplayState, 'playing-muted');
  assert.equal(harness.snapshot.playerState, 'playing');
  assert.equal(harness.snapshot.following, true);
  assert.equal(FakeAudioContext.instances.length, 0);
  await controller.destroy();
});

test('Hls.js is preferred when both MSE and native HLS are available', async () => {
  const harness = createHarness({ nativeHls: true });
  assert.equal(await harness.controller.loadLive('panda'), 'hls');
  assert.equal(harness.snapshot.engine, 'hls');
  assert.equal(FakeHls.instances.length, 1);
  await harness.controller.destroy();
});

test('NotAllowedError blocks muted autoplay once without a retry loop', async () => {
  const harness = createHarness();
  harness.video.playResults.push(notAllowed());
  await harness.controller.loadLive('panda');
  FakeHls.instances[0].emit(FakeHls.Events.MANIFEST_PARSED);
  await flush();
  assert.equal(harness.snapshot.autoplayState, 'blocked');
  assert.equal(harness.snapshot.playerState, 'ready');
  assert.equal(harness.video.playCalls, 1);
  assert.match(harness.snapshot.message, /阻擋自動播放/);
  await harness.controller.destroy();
});

test('muted autoplay remains loading while the first playable segment is pending', async () => {
  const harness = createHarness();
  let resolvePlay;
  harness.video.playResults.push(new Promise((resolve) => { resolvePlay = resolve; }));
  await harness.controller.loadLive('panda');
  FakeHls.instances[0].emit(FakeHls.Events.MANIFEST_PARSED);

  assert.equal(harness.snapshot.playerState, 'loading');
  assert.equal(harness.snapshot.autoplayState, 'attempting-muted');
  resolvePlay(true);
  await flush();
  assert.equal(harness.snapshot.playerState, 'playing');
  await harness.controller.destroy();
});

test('manual live resume remains loading while play is pending', async () => {
  const harness = createHarness();
  await harness.controller.loadLive('panda');
  FakeHls.instances[0].emit(FakeHls.Events.MANIFEST_PARSED);
  await flush();
  harness.controller.pause();

  let resolvePlay;
  harness.video.playResults.push(new Promise((resolve) => { resolvePlay = resolve; }));
  const pending = harness.controller.play();
  assert.equal(harness.snapshot.playerState, 'loading');
  assert.equal(harness.snapshot.userPaused, false);
  resolvePlay(true);
  assert.equal(await pending, true);
  assert.equal(harness.snapshot.playerState, 'playing');
  await harness.controller.destroy();
});

test('record timecode waits for metadata, clamps to duration, and never autoplays', async () => {
  const harness = createHarness();
  assert.equal(await harness.controller.loadRecord({ filename: 'panda-1700000000.mp4' }, { timecode: '999.9' }), 'native');
  harness.video.duration = 120;
  harness.video.emit('loadedmetadata');
  assert.equal(harness.video.currentTime, 120);
  assert.equal(harness.video.playCalls, 0);
  assert.equal(harness.snapshot.playerState, 'ready');
  assert.equal(harness.snapshot.paused, true);
  await harness.controller.destroy();
});

test('seeks clamp records and live DVR to playable boundaries', async () => {
  const record = createHarness();
  await record.controller.loadRecord({ filename: 'panda-1700000000.mp4' });
  record.video.duration = 20;
  record.video.currentTime = 4;
  assert.equal(record.controller.seek(record.video.currentTime - 10), true);
  assert.equal(record.video.currentTime, 0);
  record.video.currentTime = 16;
  assert.equal(record.controller.seek(record.video.currentTime + 10), true);
  assert.equal(record.video.currentTime, 20);
  await record.controller.destroy();

  const live = createHarness({ nativeHls: true, hlsSupported: false });
  live.video.buffered = new FakeTimeRanges([[5, 25]]);
  live.video.seekable = new FakeTimeRanges([[5, 25]]);
  live.video.currentTime = 10;
  await live.controller.loadLive('panda');
  assert.equal(live.controller.seek(live.video.currentTime - 10), true);
  assert.equal(live.video.currentTime, 5);
  live.video.currentTime = 20;
  assert.equal(live.controller.seek(live.video.currentTime + 10), true);
  assert.equal(live.video.currentTime, 24.75);
  assert.equal(live.snapshot.following, true);
  await live.controller.destroy();
});

test('volume zero mutes, unmute restores audible volume, and boost clamps above 100%', async () => {
  const harness = createHarness();
  await harness.controller.loadLive('panda');
  FakeHls.instances[0].emit(FakeHls.Events.MANIFEST_PARSED);
  await flush();

  assert.equal(harness.controller.setBoost(true), true);
  await harness.controller.setVolume(180);
  assert.equal(FakeAudioContext.instances[0].gains[0].gain.value, 1.8);
  assert.equal(harness.snapshot.muted, false);

  await harness.controller.setVolume(0);
  assert.equal(harness.snapshot.muted, true);
  assert.equal(harness.snapshot.muteReason, 'volume-zero');
  await harness.controller.setMuted(false);
  assert.equal(harness.snapshot.volumePercent, 180);
  assert.equal(harness.snapshot.muted, false);

  harness.controller.setBoost(false);
  assert.equal(harness.snapshot.volumePercent, 100);
  assert.equal(harness.storage.getItem('onlive.player.volumePercent'), '100');
  await harness.controller.destroy();
});

test('unsupported playback rate restores the previous selected and effective rate', async () => {
  const harness = createHarness();
  await harness.controller.loadRecord({ filename: 'panda-1700000000.mp4' });
  assert.equal(harness.controller.setPlaybackRate(4), true);
  harness.video.rejectedRates.add(16);
  assert.equal(harness.controller.setPlaybackRate(16), false);
  assert.equal(harness.snapshot.selectedRate, 4);
  assert.equal(harness.snapshot.effectiveRate, 4);
  assert.match(harness.snapshot.message, /不支援 16x/);
  await harness.controller.destroy();
});

test('HLS media recovery resets after playback and fatal errors stop live work before retry', async () => {
  const harness = createHarness();
  await harness.controller.loadLive('panda');
  const hls = FakeHls.instances[0];
  hls.emit(FakeHls.Events.ERROR, { fatal: true, type: FakeHls.ErrorTypes.MEDIA_ERROR });
  assert.equal(hls.recoveryCount, 1);
  assert.equal(harness.snapshot.playerState, 'waiting');
  harness.video.emit('playing');
  hls.emit(FakeHls.Events.ERROR, { fatal: true, type: FakeHls.ErrorTypes.MEDIA_ERROR });
  assert.equal(hls.recoveryCount, 2);
  hls.emit(FakeHls.Events.ERROR, { fatal: true, type: FakeHls.ErrorTypes.NETWORK_ERROR });
  assert.equal(harness.snapshot.playerState, 'offline');
  assert.equal(harness.snapshot.engine, 'none');
  assert.equal(hls.destroyed, true);
  assert.equal(harness.timer.callback, null);
  assert.equal(await harness.controller.retry(), 'hls');
  assert.equal(FakeHls.instances.length, 2);
  await harness.controller.destroy();
});

test('an unsupported HLS codec fails once without media recovery', async () => {
  const harness = createHarness();
  await harness.controller.loadLive('panda');
  const hls = FakeHls.instances[0];
  hls.emit(FakeHls.Events.ERROR, {
    fatal: true,
    type: FakeHls.ErrorTypes.MEDIA_ERROR,
    details: FakeHls.ErrorDetails.BUFFER_ADD_CODEC_ERROR,
    error: Object.assign(new Error('Unsupported hvc1 codec'), { name: 'NotSupportedError' }),
  });

  assert.equal(hls.recoveryCount, undefined);
  assert.equal(harness.snapshot.playerState, 'unsupported');
  assert.equal(harness.snapshot.engine, 'unsupported');
  assert.equal(hls.destroyed, true);
  assert.equal(harness.timer.callback, null);
  assert.match(harness.snapshot.message, /不支援此影音格式/);
  await harness.controller.destroy();
});

test('a pending autoplay result cannot overwrite a fatal HLS state', async () => {
  const harness = createHarness();
  let resolvePlay;
  harness.video.playResults.push(new Promise((resolve) => { resolvePlay = resolve; }));
  await harness.controller.loadLive('panda');
  const hls = FakeHls.instances[0];
  hls.emit(FakeHls.Events.MANIFEST_PARSED);
  assert.equal(harness.snapshot.playerState, 'loading');

  hls.emit(FakeHls.Events.ERROR, { fatal: true, type: FakeHls.ErrorTypes.NETWORK_ERROR });
  assert.equal(harness.snapshot.playerState, 'offline');
  resolvePlay(true);
  await flush();
  assert.equal(harness.snapshot.playerState, 'offline');
  await harness.controller.destroy();
});

test('native low-latency playback starts at the seekable edge, catches up, and goLive restores following', async () => {
  const harness = createHarness({ nativeHls: true, hlsSupported: false });
  harness.video.buffered = new FakeTimeRanges([[0, 10]]);
  harness.video.seekable = new FakeTimeRanges([[0, 10]]);
  harness.video.currentTime = 5;
  await harness.controller.loadLive('panda');
  harness.video.emit('loadedmetadata');
  await flush();
  assert.equal(harness.video.currentTime, 9.75);
  assert.equal(harness.snapshot.targetLatency, 1);

  harness.video.currentTime = 7.5;
  harness.timer.callback();
  assert.equal(harness.video.playbackRate, 1.25);
  assert.equal(harness.snapshot.catchUpActive, true);

  harness.video.buffered = new FakeTimeRanges([[0, 30]]);
  harness.video.seekable = new FakeTimeRanges([[0, 30]]);
  harness.video.currentTime = 5;
  harness.timer.callback();
  assert.equal(harness.video.currentTime, 29.75);
  assert.equal(harness.video.playbackRate, 1);
  assert.equal(harness.snapshot.following, true);

  harness.controller.seek(2);
  assert.equal(harness.snapshot.following, false);
  assert.equal(harness.controller.goLive(), true);
  assert.equal(harness.video.currentTime, 29.75);
  assert.equal(harness.snapshot.following, true);
  await harness.controller.destroy();
});

test('native live startup seeks to the latest safe position before it is buffered', async () => {
  const harness = createHarness({ nativeHls: true, hlsSupported: false });
  harness.video.buffered = new FakeTimeRanges([[0, 4]]);
  harness.video.seekable = new FakeTimeRanges([[0, 128]]);
  await harness.controller.loadLive('panda');
  harness.video.emit('loadedmetadata');
  await flush();

  assert.equal(harness.video.currentTime, 127.75);
  assert.equal(harness.snapshot.following, true);
  assert.equal(harness.snapshot.atLiveEdge, true);
  await harness.controller.destroy();
});

test('native unsupported source is not reported as an offline channel', async () => {
  const harness = createHarness({ nativeHls: true, hlsSupported: false });
  await harness.controller.loadLive('panda');
  harness.video.crossOrigin = null;
  harness.video.error = { code: 4, message: 'decoder initialization failed' };
  harness.video.emit('error');

  assert.equal(harness.snapshot.playerState, 'unsupported');
  assert.match(harness.snapshot.message, /不支援此影音格式/);
  await harness.controller.destroy();
});

test('HLS latency profiles persist and catch-up pauses for fixed playback rates', async () => {
  const harness = createHarness();
  harness.video.seekable = new FakeTimeRanges([[0, 22]]);
  harness.video.buffered = new FakeTimeRanges([[0, 22]]);
  harness.video.currentTime = 12;
  await harness.controller.loadLive('panda');
  const hls = FakeHls.instances[0];
  hls.emit(FakeHls.Events.MANIFEST_PARSED);
  await flush();
  harness.timer.callback();
  assert.equal(hls.config.maxLiveSyncPlaybackRate, 1.25);
  harness.controller.setPlaybackRate(2);
  assert.equal(hls.config.maxLiveSyncPlaybackRate, 1);
  harness.controller.setPlaybackRate(1);
  assert.equal(hls.config.maxLiveSyncPlaybackRate, 1.25);
  harness.video.seekable = new FakeTimeRanges([[0, 20]]);
  harness.controller.seek(2);
  assert.equal(harness.snapshot.following, false);
  assert.equal(hls.config.liveMaxLatencyDurationCount, Number.POSITIVE_INFINITY);
  harness.controller.goLive();
  assert.equal(hls.config.liveMaxLatencyDurationCount, LIVE_LATENCY_PROFILES.low.liveMaxLatencyDurationCount);
  harness.controller.setLowLatency(false);
  assert.equal(hls.config.maxLiveSyncPlaybackRate, 1);
  assert.equal(hls.config.liveSyncDurationCount, 3);
  assert.equal(hls.config.liveMaxLatencyDurationCount, 6);
  assert.equal(hls.config.initialLiveManifestSize, 3);
  assert.equal(hls.config.lowLatencyMode, false);
  assert.equal(harness.storage.getItem('onlive.player.lowLatency'), 'false');
  await harness.controller.destroy();

  const stable = createHarness({ storageValues: { 'onlive.player.lowLatency': 'false' } });
  await stable.controller.loadLive('panda');
  assert.deepEqual(
    Object.fromEntries(Object.keys(LIVE_LATENCY_PROFILES.stable).map((key) => [key, FakeHls.instances.at(-1).config[key]])),
    LIVE_LATENCY_PROFILES.stable,
  );
  assert.equal(stable.snapshot.lowLatency, false);
  await stable.controller.destroy();
});

test('HLS catch-up returns to 1x at the live position or when forward buffer is low', async () => {
  const harness = createHarness();
  harness.video.seekable = new FakeTimeRanges([[0, 24]]);
  harness.video.buffered = new FakeTimeRanges([[0, 24]]);
  harness.video.currentTime = 12;
  await harness.controller.loadLive('panda');
  const hls = FakeHls.instances[0];
  hls.liveSyncPosition = 20;
  hls.emit(FakeHls.Events.MANIFEST_PARSED);
  await flush();

  harness.timer.callback();
  assert.equal(hls.config.maxLiveSyncPlaybackRate, 1.25);

  harness.video.playbackRate = 1.25;
  harness.video.currentTime = 19;
  harness.timer.callback();
  assert.equal(harness.video.playbackRate, 1);
  assert.equal(hls.config.maxLiveSyncPlaybackRate, 1);
  assert.equal(harness.snapshot.catchUpReason, 'live-edge');

  harness.video.playbackRate = 1.25;
  harness.video.currentTime = 16;
  harness.video.buffered = new FakeTimeRanges([[0, 17.5]]);
  harness.timer.callback();
  assert.equal(harness.video.playbackRate, 1);
  assert.equal(hls.config.maxLiveSyncPlaybackRate, 1);
  assert.equal(hls.config.liveMaxLatencyDurationCount, Number.POSITIVE_INFINITY);
  assert.equal(harness.snapshot.catchUpReason, 'forward-buffer-low');
  await harness.controller.destroy();
});

test('automatic native correction does not seek into an unbuffered live segment', async () => {
  const harness = createHarness({ nativeHls: true, hlsSupported: false });
  harness.video.seekable = new FakeTimeRanges([[0, 20]]);
  harness.video.buffered = new FakeTimeRanges([[0, 10]]);
  harness.video.currentTime = 5;
  await harness.controller.loadLive('panda');
  harness.video.paused = false;
  harness.video.currentTime = 5;
  harness.timer.callback();
  assert.equal(harness.video.currentTime, 5);
  assert.equal(harness.video.playbackRate, 1.25);

  harness.video.currentTime = 9;
  harness.timer.callback();
  assert.equal(harness.video.currentTime, 9);
  assert.equal(harness.video.playbackRate, 1);
  assert.equal(harness.snapshot.ended, false);
  await harness.controller.destroy();
});

test('a live stream with no playable content waits and resumes instead of becoming paused', async () => {
  const harness = createHarness({ nativeHls: true, hlsSupported: false });
  harness.video.seekable = new FakeTimeRanges([[0, 10]]);
  harness.video.buffered = new FakeTimeRanges([[0, 10]]);
  await harness.controller.loadLive('panda');
  harness.video.emit('loadedmetadata');
  await flush();

  harness.video.paused = true;
  harness.video.ended = false;
  harness.video.emit('pause');
  assert.equal(harness.snapshot.playerState, 'waiting');

  harness.video.ended = true;
  harness.video.emit('ended');
  assert.equal(harness.snapshot.playerState, 'waiting');
  assert.equal(harness.snapshot.userPaused, false);
  assert.equal(harness.snapshot.following, true);
  assert.match(harness.snapshot.message, /等待直播內容/);

  const playCalls = harness.video.playCalls;
  harness.video.ended = false;
  harness.video.emit('canplay');
  await flush();
  assert.equal(harness.video.playCalls, playCalls + 1);
  assert.equal(harness.snapshot.playerState, 'playing');
  assert.equal(harness.snapshot.userPaused, false);
  await harness.controller.destroy();
});

test('goLive and the DVR timeline use HLS liveSyncPosition instead of buffered end', async () => {
  const harness = createHarness();
  harness.video.seekable = new FakeTimeRanges([[100, 140]]);
  harness.video.buffered = new FakeTimeRanges([[100, 120]]);
  harness.video.currentTime = 110;
  await harness.controller.loadLive('panda');
  const hls = FakeHls.instances[0];
  hls.liveSyncPosition = 136;

  harness.timer.callback();
  assert.equal(harness.snapshot.timelineStart, 100);
  assert.equal(harness.snapshot.timelineEnd, 136);
  assert.equal(harness.snapshot.livePosition, 136);
  assert.equal(harness.snapshot.atLiveEdge, false);
  assert.equal(harness.controller.goLive(), true);
  assert.equal(harness.video.currentTime, 136);
  assert.equal(harness.snapshot.following, true);

  harness.video.currentTime = 110;
  harness.video.buffered = new FakeTimeRanges([[100, 138]]);
  assert.equal(harness.controller.goLive(), true);
  assert.equal(harness.video.currentTime, 136);
  harness.video.emit('seeked');
  assert.equal(harness.snapshot.following, true);
  assert.equal(harness.snapshot.atLiveEdge, true);
  await harness.controller.destroy();
});

test('automatic correction does not treat the exact buffered endpoint as playable', async () => {
  const harness = createHarness();
  harness.video.seekable = new FakeTimeRanges([[0, 12]]);
  harness.video.buffered = new FakeTimeRanges([[0, 10]]);
  harness.video.currentTime = 2;
  await harness.controller.loadLive('panda');
  const hls = FakeHls.instances[0];
  hls.liveSyncPosition = 10;
  hls.latency = 20;
  hls.targetLatency = 3;
  harness.video.paused = false;

  harness.timer.callback();
  assert.equal(harness.video.currentTime, 2);
  assert.equal(hls.config.liveMaxLatencyDurationCount, Number.POSITIVE_INFINITY);
  assert.equal(harness.controller.goLive(), true);
  assert.equal(harness.video.currentTime, 10);
  await harness.controller.destroy();
});

test('HLS buffer append resumes a live stream waiting for new content', async () => {
  const harness = createHarness();
  harness.video.seekable = new FakeTimeRanges([[0, 12]]);
  harness.video.buffered = new FakeTimeRanges([[0, 12]]);
  await harness.controller.loadLive('panda');
  const hls = FakeHls.instances[0];
  hls.liveSyncPosition = 10;
  hls.emit(FakeHls.Events.MANIFEST_PARSED);
  await flush();

  harness.video.paused = true;
  harness.video.ended = true;
  harness.video.emit('ended');
  const playCalls = harness.video.playCalls;
  harness.video.ended = false;
  hls.emit(FakeHls.Events.BUFFER_APPENDED);
  await flush();

  assert.equal(harness.video.playCalls, playCalls + 1);
  assert.equal(harness.snapshot.playerState, 'playing');
  await harness.controller.destroy();
});

test('an obsolete native CORS probe cannot mutate the replacement source', async () => {
  const probes = [];
  const response = (ok) => ({ ok, body: { cancel: () => Promise.resolve() } });
  const harness = createHarness({
    nativeHls: true,
    hlsSupported: false,
    fetchResult: () => new Promise((resolve) => probes.push(resolve)),
  });

  const first = harness.controller.loadLive('first');
  await flush();
  const second = harness.controller.loadLive('second');
  await flush();
  probes[1](response(true));
  assert.equal(await second, 'native');
  const activeVideo = harness.container.video;
  assert.equal(activeVideo.crossOrigin, 'anonymous');

  probes[0](response(false));
  assert.equal(await first, 'cancelled');
  assert.equal(harness.container.video, activeVideo);
  assert.equal(activeVideo.crossOrigin, 'anonymous');
  assert.equal(harness.snapshot.source, 'second');
  await harness.controller.destroy();
});

test('following survives pause/resume and foreground recovery while excessive latency snaps to live', async () => {
  const harness = createHarness();
  harness.video.seekable = new FakeTimeRanges([[0, 24]]);
  harness.video.buffered = new FakeTimeRanges([[0, 24]]);
  await harness.controller.loadLive('panda');
  const hls = FakeHls.instances[0];
  hls.liveSyncPosition = 21;
  hls.emit(FakeHls.Events.MANIFEST_PARSED);
  await flush();

  harness.controller.pause();
  assert.equal(harness.snapshot.following, true);
  await harness.controller.play();
  assert.equal(harness.snapshot.following, true);
  hls.latency = 10;
  hls.targetLatency = 3;
  harness.video.currentTime = 5;
  harness.timer.callback();
  assert.equal(harness.video.currentTime, 21);

  harness.document.visibilityState = 'hidden';
  harness.document.emit('visibilitychange');
  harness.video.paused = true;
  harness.document.visibilityState = 'visible';
  harness.document.emit('visibilitychange');
  await flush();
  assert.equal(harness.video.paused, false);
  assert.equal(harness.snapshot.following, true);
  await harness.controller.destroy();
});

test('cross-origin unsafe source disables boost and replaces a Web-Audio-routed video', async () => {
  const harness = createHarness({ fetchResult: new TypeError('CORS blocked') });
  await harness.controller.loadLive('panda');
  FakeHls.instances[0].emit(FakeHls.Events.MANIFEST_PARSED);
  await flush();
  await harness.controller.setMuted(false);
  const original = harness.video;
  await harness.controller.loadRecord({ filename: 'panda-1700000000.mp4' });
  assert.notEqual(harness.container.video, original);
  assert.equal(harness.snapshot.boostAvailable, false);
  assert.match(harness.snapshot.boostUnavailableReason, /CORS/);
  await harness.controller.destroy();
});

test('cleanup keeps AudioContext reusable while destroy closes it and removes timers', async () => {
  const harness = createHarness();
  await harness.controller.loadLive('panda');
  FakeHls.instances[0].emit(FakeHls.Events.MANIFEST_PARSED);
  await flush();
  await harness.controller.setMuted(false);
  const context = FakeAudioContext.instances[0];
  harness.controller.cleanup();
  assert.equal(context.state, 'running');
  assert.equal(harness.snapshot.playerState, 'idle');
  assert.equal(harness.timer.callback, null);
  await harness.controller.destroy();
  assert.equal(context.state, 'closed');
});
