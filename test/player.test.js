import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayerController } from '../src/player.js';

class FakeVideo {
  constructor(nativeHls = false) {
    this.nativeHls = nativeHls;
    this.listeners = new Map();
    this.src = '';
  }
  canPlayType() { return this.nativeHls ? 'probably' : ''; }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  removeEventListener(type) { this.listeners.delete(type); }
  emit(type) { this.listeners.get(type)?.(); }
  load() {}
  pause() {}
  removeAttribute(name) { if (name === 'src') this.src = ''; }
}

class FakeHls {
  static Events = { MANIFEST_PARSED: 'manifest', ERROR: 'error' };
  static ErrorTypes = { NETWORK_ERROR: 'network', MEDIA_ERROR: 'media' };
  static instances = [];
  static isSupported() { return true; }
  constructor() { this.handlers = new Map(); this.destroyed = false; FakeHls.instances.push(this); }
  on(type, handler) { this.handlers.set(type, handler); }
  emit(type, data) { this.handlers.get(type)?.(type, data); }
  loadSource(url) { this.url = url; }
  attachMedia(video) { this.video = video; }
  recoverMediaError() { this.recovered = true; }
  destroy() { this.destroyed = true; }
}

test('prefers native HLS when the video element supports it', () => {
  const video = new FakeVideo(true);
  const states = [];
  const player = createPlayerController({ getVideo: () => video, getHls: () => FakeHls, onState: (state) => states.push(state) });
  assert.equal(player.loadLive('test'), 'native');
  assert.match(video.src, /\/live\/test\.m3u8$/);
  video.emit('loadedmetadata');
  assert.equal(states.at(-1), 'ready');
});

test('uses hls.js, recovers one media error, and reports fatal network errors', () => {
  FakeHls.instances = [];
  const video = new FakeVideo(false);
  const states = [];
  const player = createPlayerController({ getVideo: () => video, getHls: () => FakeHls, onState: (state) => states.push(state) });
  assert.equal(player.loadLive('test'), 'hls');
  const hls = FakeHls.instances[0];
  hls.emit(FakeHls.Events.ERROR, { fatal: true, type: FakeHls.ErrorTypes.MEDIA_ERROR });
  assert.equal(hls.recovered, true);
  hls.emit(FakeHls.Events.ERROR, { fatal: true, type: FakeHls.ErrorTypes.NETWORK_ERROR });
  assert.equal(states.at(-1), 'offline');
  assert.equal(hls.destroyed, true);
});

test('loads recordings natively and cleans up resources', () => {
  const video = new FakeVideo(false);
  const player = createPlayerController({ getVideo: () => video, getHls: () => FakeHls });
  player.loadRecord({ filename: 'cute_panda-1700000000.flv' });
  assert.match(video.src, /\/record\/cute_panda-1700000000\.flv$/);
  player.cleanup();
  assert.equal(video.src, '');
});
