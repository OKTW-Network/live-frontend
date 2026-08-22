import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPlaybackToggleCoordinator,
  createPlayerGestureRecognizer,
  isPlayerGestureBlockedTarget,
} from '../src/player-gestures.js';

function createClock() {
  let currentTime = 0;
  let sequence = 0;
  const timers = new Map();

  function setTimeoutImpl(callback, delay) {
    const id = ++sequence;
    timers.set(id, { callback, dueAt: currentTime + delay });
    return id;
  }

  function clearTimeoutImpl(id) {
    timers.delete(id);
  }

  function tick(milliseconds) {
    const target = currentTime + milliseconds;
    while (true) {
      const next = [...timers.entries()]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort((first, second) => first[1].dueAt - second[1].dueAt || first[0] - second[0])[0];
      if (!next) break;
      const [id, timer] = next;
      timers.delete(id);
      currentTime = timer.dueAt;
      timer.callback();
    }
    currentTime = target;
  }

  return {
    now: () => currentTime,
    setTimeoutImpl,
    clearTimeoutImpl,
    tick,
  };
}

function createHarness(overrides = {}) {
  const clock = createClock();
  const calls = { mouseSingle: [], mouseDouble: [], touchSingle: [], touchDouble: [] };
  const recognizer = createPlayerGestureRecognizer({
    now: clock.now,
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
    onMouseSingle: (gesture) => calls.mouseSingle.push(gesture),
    onMouseDouble: (gesture) => calls.mouseDouble.push(gesture),
    onTouchSingle: (gesture) => calls.touchSingle.push(gesture),
    onTouchDouble: (gesture) => { calls.touchDouble.push(gesture); return true; },
    ...overrides,
  });
  return { clock, calls, recognizer };
}

function tap(recognizer, { pointerType, x, y = 20, zone, pointerId = 1, button = 0 } = {}) {
  recognizer.pointerDown({ pointerId, pointerType, button, clientX: x, clientY: y, zone, isPrimary: true });
  recognizer.pointerUp({ pointerId, pointerType, button, clientX: x, clientY: y, zone, isPrimary: true });
}

test('mouse single waits for the double-click window and a nearby double suppresses it', () => {
  const single = createHarness();
  tap(single.recognizer, { pointerType: 'mouse', x: 100 });
  single.clock.tick(299);
  assert.equal(single.calls.mouseSingle.length, 0);
  single.clock.tick(1);
  assert.equal(single.calls.mouseSingle.length, 1);

  const double = createHarness();
  tap(double.recognizer, { pointerType: 'mouse', x: 100 });
  double.clock.tick(100);
  tap(double.recognizer, { pointerType: 'mouse', x: 108 });
  assert.equal(double.calls.mouseDouble.length, 1);
  double.clock.tick(300);
  assert.equal(double.calls.mouseSingle.length, 0);
});

test('touch same-side doubles report zone while cross-side taps stay independent singles', () => {
  const harness = createHarness();
  tap(harness.recognizer, { pointerType: 'touch', x: 80, zone: 'left' });
  harness.clock.tick(100);
  tap(harness.recognizer, { pointerType: 'touch', x: 88, zone: 'left' });
  assert.equal(harness.calls.touchDouble.at(-1).zone, 'left');

  tap(harness.recognizer, { pointerType: 'touch', x: 80, zone: 'left' });
  harness.clock.tick(100);
  tap(harness.recognizer, { pointerType: 'touch', x: 280, zone: 'right' });
  harness.clock.tick(300);
  assert.equal(harness.calls.touchSingle.length, 2);
  assert.equal(harness.calls.touchDouble.length, 1);
});

test('playback toggle reports feedback only on success and suppresses cancel or media change', async () => {
  const snapshot = { paused: true };
  const feedback = [];
  let mediaKey = 'record:one';
  let resolvePlay;
  const player = {
    play: () => new Promise((resolve) => { resolvePlay = resolve; }),
    pause() { snapshot.paused = true; },
  };
  const coordinator = createPlaybackToggleCoordinator({
    getPlayer: () => player,
    getSnapshot: () => snapshot,
    getMediaKey: () => mediaKey,
    onFeedback: (action) => feedback.push(action),
  });

  const pending = coordinator.toggle({ showFeedback: true });
  snapshot.paused = false;
  resolvePlay(true);
  assert.equal(await pending, true);
  assert.deepEqual(feedback, ['play']);

  assert.equal(await coordinator.toggle({ showFeedback: true }), true);
  assert.deepEqual(feedback, ['play', 'pause']);

  snapshot.paused = true;
  const cancelled = coordinator.toggle({ showFeedback: true });
  coordinator.cancel();
  snapshot.paused = false;
  resolvePlay(true);
  assert.equal(await cancelled, false);

  snapshot.paused = true;
  const changed = coordinator.toggle({ showFeedback: true });
  mediaKey = 'record:two';
  snapshot.paused = false;
  resolvePlay(true);
  assert.equal(await changed, false);
  assert.deepEqual(feedback, ['play', 'pause']);
});

test('recognizes player controls as blocked gesture targets', () => {
  assert.equal(isPlayerGestureBlockedTarget({ closest: (selector) => selector.includes('.player-controls') ? {} : null }), true);
  assert.equal(isPlayerGestureBlockedTarget({ closest: () => null }), false);
});
