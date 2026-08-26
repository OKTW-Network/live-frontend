import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayerComponent } from '../src/components/player.js';

function componentWith(snapshot) {
  const component = createPlayerComponent({ raw: (value) => value });
  component.playerSnapshot = { ...component.playerSnapshot, ...snapshot };
  return component;
}

test('live timeline values are relative to the DVR window', () => {
  const component = componentWith({
    mode: 'live', timelineStart: 100, timelineEnd: 136, currentTime: 124,
  });
  assert.equal(component.playerTimelineMax(), 36);
  assert.equal(component.playerTimelineValue(), 24);

  let target = null;
  component.player = { seek: (value) => { target = value; } };
  component.seekPlayer({ target: { value: '18.5' } });
  assert.equal(target, 118.5);
});

test('live player labels distinguish the selected live position from DVR playback', () => {
  const live = componentWith({
    mode: 'live', atLiveEdge: true, latency: 1.24, livePosition: 136, currentTime: 135.8,
  });
  assert.equal(live.playerTimeLabel(), 'LIVE · 延遲 1.2 秒');

  const loading = componentWith({
    mode: 'live', following: true, atLiveEdge: false, latency: null, livePosition: null,
  });
  assert.equal(loading.playerTimeLabel(), 'LIVE');

  const dvr = componentWith({
    mode: 'live', atLiveEdge: false, latency: 20, livePosition: 136, currentTime: 65,
  });
  assert.equal(dvr.playerTimeLabel(), 'DVR · 落後 1:11');
});

test('live buffering is exposed as loading instead of a paused control', () => {
  const waiting = componentWith({ mode: 'live', playerState: 'waiting', userPaused: false, paused: true });
  assert.equal(waiting.playerIsLoading(), true);
  waiting.playerSnapshot.userPaused = true;
  assert.equal(waiting.playerIsLoading(), false);
});
