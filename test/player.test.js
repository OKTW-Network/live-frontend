import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayerController } from '../src/player/controller.js';

class FakeEventTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }
  removeEventListener(type, handler) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((candidate) => candidate !== handler));
  }
  emit(type, detail = {}) {
    for (const handler of [...(this.listeners.get(type) || [])]) handler({ type, target: this, ...detail });
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
  static Events = { MANIFEST_PARSED: 'manifest', ERROR: 'error', LEVEL_LOADED: 'level-loaded' };
  static ErrorTypes = { NETWORK_ERROR: 'network', MEDIA_ERROR: 'media' };
  static instances = [];
  static isSupported() { return true; }
  constructor(config) {
    this.config = { ...config };
    this.handlers = new Map();
    this.destroyed = false;
    this.latency = 4;
    this.targetLatency = 3;
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
  recoverMediaError() { this.recovered = true; }
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
  const videoChanges = [];
  const controller = createPlayerController({
    video,
    container,
    getHls: () => FakeHls,
    storage,
    environment: {
      AudioContext,
      document,
      navigator,
      location: { href },
      fetch: async () => {
        if (fetchResult instanceof Error) throw fetchResult;
        return fetchResult;
      },
      now: () => 1_700_000_000_000,
      setInterval: (callback) => { timer.callback = callback; return 1; },
      clearInterval: () => { timer.cleared = true; timer.callback = null; },
    },
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onVideoChange: (next) => videoChanges.push(next),
  });
  return {
    video, container, document, storage, snapshots, timer, videoChanges, controller,
    get snapshot() { return snapshots.at(-1); },
  };
}

test('live HLS is muted before attachment and autoplay state follows the play promise', async () => {
  FakeHls.instances = [];
  const harness = createHarness();
  const { controller, video } = harness;
  assert.equal(await controller.loadLive('panda'), 'hls');
  const hls = FakeHls.instances[0];
  assert.equal(hls.mutedWhenAttached, true);
  assert.equal(hls.config.maxLiveSyncPlaybackRate, 1.25);
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

test('NotAllowedError blocks muted autoplay once without a retry loop', async () => {
  FakeHls.instances = [];
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

  const live = createHarness({ nativeHls: true });
  live.video.buffered = new FakeTimeRanges([[5, 25]]);
  live.video.seekable = new FakeTimeRanges([[5, 25]]);
  live.video.currentTime = 10;
  await live.controller.loadLive('panda');
  assert.equal(live.controller.seek(live.video.currentTime - 10), true);
  assert.equal(live.video.currentTime, 5);
  live.video.currentTime = 20;
  assert.equal(live.controller.seek(live.video.currentTime + 10), true);
  assert.equal(live.video.currentTime, 25);
  assert.equal(live.snapshot.following, true);
  await live.controller.destroy();
});

test('volume zero mutes, unmute restores audible volume, and boost clamps above 100%', async () => {
  FakeAudioContext.instances = [];
  FakeAudioContext.failResume = false;
  FakeHls.instances = [];
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
  assert.equal(harness.storage.getItem('oktw.player.volumePercent'), '100');
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

test('HLS media errors recover once and fatal network errors report offline', async () => {
  FakeHls.instances = [];
  const harness = createHarness();
  await harness.controller.loadLive('panda');
  const hls = FakeHls.instances[0];
  hls.emit(FakeHls.Events.ERROR, { fatal: true, type: FakeHls.ErrorTypes.MEDIA_ERROR });
  assert.equal(hls.recovered, true);
  hls.emit(FakeHls.Events.ERROR, { fatal: true, type: FakeHls.ErrorTypes.NETWORK_ERROR });
  assert.equal(harness.snapshot.playerState, 'offline');
  assert.equal(hls.destroyed, true);
  await harness.controller.destroy();
});

test('native catch-up establishes latency target, speeds up, and goLive restores following', async () => {
  const harness = createHarness({ nativeHls: true });
  harness.video.buffered = new FakeTimeRanges([[0, 10]]);
  harness.video.seekable = new FakeTimeRanges([[0, 10]]);
  harness.video.currentTime = 5;
  await harness.controller.loadLive('panda');
  harness.video.emit('loadedmetadata');
  await flush();
  for (let index = 0; index < 5; index += 1) harness.timer.callback();
  assert.equal(harness.snapshot.targetLatency, 5);

  harness.video.currentTime = 3;
  harness.timer.callback();
  assert.equal(harness.video.playbackRate, 1.25);
  assert.equal(harness.snapshot.catchUpActive, true);

  harness.controller.seek(2);
  assert.equal(harness.snapshot.following, false);
  assert.equal(harness.controller.goLive(), true);
  assert.equal(harness.video.currentTime, 9.75);
  assert.equal(harness.snapshot.following, true);
  await harness.controller.destroy();
});

test('HLS catch-up rate pauses for non-1x selection and resumes at 1x', async () => {
  FakeHls.instances = [];
  const harness = createHarness();
  await harness.controller.loadLive('panda');
  const hls = FakeHls.instances[0];
  hls.emit(FakeHls.Events.MANIFEST_PARSED);
  await flush();
  assert.equal(hls.config.maxLiveSyncPlaybackRate, 1.25);
  harness.controller.setPlaybackRate(2);
  assert.equal(hls.config.maxLiveSyncPlaybackRate, 1);
  harness.controller.setPlaybackRate(1);
  assert.equal(hls.config.maxLiveSyncPlaybackRate, 1.25);
  harness.controller.setAutoCatchUp(false);
  assert.equal(hls.config.maxLiveSyncPlaybackRate, 1);
  await harness.controller.destroy();
});

test('cross-origin unsafe source disables boost and replaces a Web-Audio-routed video', async () => {
  FakeAudioContext.failResume = false;
  FakeHls.instances = [];
  const harness = createHarness({ fetchResult: new TypeError('CORS blocked') });
  await harness.controller.loadLive('panda');
  FakeHls.instances[0].emit(FakeHls.Events.MANIFEST_PARSED);
  await flush();
  await harness.controller.setMuted(false);
  const original = harness.video;
  await harness.controller.loadRecord({ filename: 'panda-1700000000.mp4' });
  assert.equal(harness.videoChanges.length, 1);
  assert.notEqual(harness.container.video, original);
  assert.equal(harness.snapshot.boostAvailable, false);
  assert.match(harness.snapshot.boostUnavailableReason, /CORS/);
  await harness.controller.destroy();
});

test('cleanup keeps AudioContext reusable while destroy closes it and removes timers', async () => {
  FakeAudioContext.instances = [];
  FakeAudioContext.failResume = false;
  FakeHls.instances = [];
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
