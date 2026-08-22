import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAYER_GESTURE_CONFIG,
  createPlaybackControlActivationTracker,
  createPlayerGestureFeedbackController,
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
    get timerCount() { return timers.size; },
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

test('exposes the agreed player gesture timings and distances', () => {
  assert.deepEqual(PLAYER_GESTURE_CONFIG, {
    doubleTapDelay: 300,
    maximumTapDuration: 350,
    maximumTapMovement: 16,
    maximumDoubleTapDistance: 48,
    touchSeekSeconds: 10,
    feedbackDuration: 650,
    controlActivationMaximumAge: 1000,
  });
});

test('playback control activation distinguishes touch from mouse and keyboard', () => {
  const tracker = createPlaybackControlActivationTracker();

  tracker.pointerDown({ pointerId: 1, pointerType: 'touch', isPrimary: true, timeStamp: 100 }, 'primary');
  assert.equal(tracker.consume({ detail: 1, timeStamp: 150 }, 'primary'), true);

  tracker.pointerDown({ pointerId: 2, pointerType: 'mouse', isPrimary: true, timeStamp: 200 }, 'primary');
  assert.equal(tracker.consume({ detail: 1, timeStamp: 220 }, 'primary'), false);

  tracker.pointerDown({ pointerId: 3, pointerType: 'touch', isPrimary: true, timeStamp: 300 }, 'primary');
  assert.equal(tracker.consume({ detail: 0, timeStamp: 320 }, 'primary'), false);
  assert.equal(tracker.consume({ detail: 1, timeStamp: 330 }, 'primary'), false);
});

test('playback control activation clears cancelled, dragged, stale, and mismatched pointers', () => {
  const tracker = createPlaybackControlActivationTracker();

  tracker.pointerDown({ pointerId: 1, pointerType: 'touch', isPrimary: true, timeStamp: 100 }, 'primary');
  tracker.pointerCancel({ pointerId: 1 }, 'primary');
  assert.equal(tracker.consume({ detail: 1, timeStamp: 120 }, 'primary'), false);

  tracker.pointerDown({ pointerId: 2, pointerType: 'touch', isPrimary: true, timeStamp: 200 }, 'primary');
  tracker.pointerLeave({ pointerId: 2, buttons: 1 }, 'primary');
  assert.equal(tracker.consume({ detail: 1, timeStamp: 220 }, 'primary'), false);

  tracker.pointerDown({ pointerId: 3, pointerType: 'touch', isPrimary: true, timeStamp: 300 }, 'primary');
  assert.equal(tracker.pointerLeave({ pointerId: 3, buttons: 0 }, 'primary'), false);
  assert.equal(tracker.consume({ detail: 1, timeStamp: 350 }, 'primary'), true);

  tracker.pointerDown({ pointerId: 4, pointerType: 'touch', isPrimary: true, timeStamp: 400 }, 'primary');
  assert.equal(tracker.consume({ detail: 1, timeStamp: 401 }, 'autoplay'), false);

  tracker.pointerDown({ pointerId: 5, pointerType: 'touch', isPrimary: true, timeStamp: 500 }, 'primary');
  assert.equal(tracker.consume({ detail: 1, timeStamp: 1501 }, 'primary'), false);

  tracker.pointerDown({ pointerId: 6, pointerType: 'touch', isPrimary: true, timeStamp: 1600 }, 'primary');
  tracker.reset();
  assert.equal(tracker.consume({ detail: 1, timeStamp: 1650 }, 'primary'), false);
});

test('new gesture feedback immediately replaces and extends beyond the old event', () => {
  const clock = createClock();
  const changes = [];
  const controller = createPlayerGestureFeedbackController({
    onChange: (feedback) => changes.push(feedback),
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
  });

  const play = controller.show({ type: 'playback', action: 'play' });
  clock.tick(300);
  const pause = controller.show({ type: 'playback', action: 'pause' });

  assert.notEqual(play.id, pause.id);
  assert.equal(changes.at(-1).action, 'pause');
  assert.equal(clock.timerCount, 1);

  clock.tick(350);
  assert.equal(changes.at(-1).action, 'pause');
  clock.tick(300);
  assert.equal(changes.at(-1), null);
});

test('playback toggle reports successful play and pause actions only when requested', async () => {
  const snapshot = { paused: true };
  const feedback = [];
  let playCalls = 0;
  const player = {
    async play() { playCalls += 1; snapshot.paused = false; return true; },
    pause() { snapshot.paused = true; },
  };
  const coordinator = createPlaybackToggleCoordinator({
    getPlayer: () => player,
    getSnapshot: () => snapshot,
    getMediaKey: () => 'record:panda',
    onFeedback: (action) => feedback.push(action),
  });

  assert.equal(await coordinator.toggle({ showFeedback: true }), true);
  assert.deepEqual(feedback, ['play']);
  assert.equal(await coordinator.toggle({ showFeedback: true }), true);
  assert.deepEqual(feedback, ['play', 'pause']);
  assert.equal(await coordinator.toggle(), true);
  assert.deepEqual(feedback, ['play', 'pause']);
  assert.equal(playCalls, 2);
  assert.equal(await coordinator.toggle({ forcePlay: true, showFeedback: true }), true);
  assert.equal(playCalls, 3);
  assert.deepEqual(feedback, ['play', 'pause', 'play']);
});

test('playback toggle suppresses feedback after failure, cancellation, or a media change', async () => {
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

  snapshot.paused = true;
  const failed = coordinator.toggle({ showFeedback: true });
  resolvePlay(false);
  assert.equal(await failed, false);
  assert.deepEqual(feedback, []);
});

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

test('touch single waits while same-side doubles report their side', () => {
  const harness = createHarness();
  tap(harness.recognizer, { pointerType: 'touch', x: 80, zone: 'left' });
  harness.clock.tick(300);
  assert.equal(harness.calls.touchSingle.length, 1);

  tap(harness.recognizer, { pointerType: 'touch', x: 80, zone: 'left' });
  harness.clock.tick(100);
  tap(harness.recognizer, { pointerType: 'touch', x: 88, zone: 'left' });
  assert.equal(harness.calls.touchDouble.at(-1).zone, 'left');

  tap(harness.recognizer, { pointerType: 'touch', x: 280, zone: 'right' });
  harness.clock.tick(100);
  tap(harness.recognizer, { pointerType: 'touch', x: 286, zone: 'right' });
  assert.equal(harness.calls.touchDouble.at(-1).zone, 'right');
});

test('an unavailable touch double falls back to one single action', () => {
  const clock = createClock();
  let singles = 0;
  let doubles = 0;
  const recognizer = createPlayerGestureRecognizer({
    now: clock.now,
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
    onTouchSingle: () => { singles += 1; },
    onTouchDouble: () => { doubles += 1; return false; },
  });
  tap(recognizer, { pointerType: 'touch', x: 80, zone: 'left' });
  clock.tick(100);
  tap(recognizer, { pointerType: 'touch', x: 85, zone: 'left' });
  assert.equal(doubles, 1);
  assert.equal(singles, 1);
  assert.equal(clock.timerCount, 0);
});

test('cross-side and distant taps remain independent singles', () => {
  const harness = createHarness();
  tap(harness.recognizer, { pointerType: 'touch', x: 80, zone: 'left' });
  harness.clock.tick(100);
  tap(harness.recognizer, { pointerType: 'touch', x: 280, zone: 'right' });
  assert.equal(harness.calls.touchSingle.length, 1);
  harness.clock.tick(300);
  assert.equal(harness.calls.touchSingle.length, 2);
  assert.equal(harness.calls.touchDouble.length, 0);

  tap(harness.recognizer, { pointerType: 'mouse', x: 20 });
  harness.clock.tick(100);
  tap(harness.recognizer, { pointerType: 'mouse', x: 200 });
  assert.equal(harness.calls.mouseSingle.length, 1);
  harness.clock.tick(300);
  assert.equal(harness.calls.mouseSingle.length, 2);
  assert.equal(harness.calls.mouseDouble.length, 0);
});

test('movement, long presses, cancellation, extra buttons, and unsupported pointers do nothing', () => {
  const harness = createHarness();
  const { recognizer, clock, calls } = harness;

  recognizer.pointerDown({ pointerId: 1, pointerType: 'touch', button: 0, clientX: 10, clientY: 10, zone: 'left' });
  recognizer.pointerMove({ pointerId: 1, pointerType: 'touch', clientX: 30, clientY: 10, zone: 'left' });
  recognizer.pointerUp({ pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10, zone: 'left' });

  recognizer.pointerDown({ pointerId: 2, pointerType: 'touch', button: 0, clientX: 10, clientY: 10, zone: 'left' });
  clock.tick(351);
  recognizer.pointerUp({ pointerId: 2, pointerType: 'touch', clientX: 10, clientY: 10, zone: 'left' });

  recognizer.pointerDown({ pointerId: 3, pointerType: 'touch', button: 0, clientX: 10, clientY: 10, zone: 'left' });
  recognizer.pointerCancel({ pointerId: 3 });
  recognizer.pointerUp({ pointerId: 3, pointerType: 'touch', clientX: 10, clientY: 10, zone: 'left' });

  tap(recognizer, { pointerType: 'mouse', x: 10, button: 2, pointerId: 4 });
  tap(recognizer, { pointerType: 'pen', x: 10, pointerId: 5 });
  clock.tick(500);
  assert.deepEqual(calls, { mouseSingle: [], mouseDouble: [], touchSingle: [], touchDouble: [] });
});

test('reset and destroy clear delayed actions', () => {
  const harness = createHarness();
  tap(harness.recognizer, { pointerType: 'mouse', x: 100 });
  assert.equal(harness.clock.timerCount, 1);
  harness.recognizer.reset();
  harness.clock.tick(500);
  assert.equal(harness.calls.mouseSingle.length, 0);

  tap(harness.recognizer, { pointerType: 'touch', x: 100, zone: 'left' });
  harness.recognizer.destroy();
  harness.clock.tick(500);
  assert.equal(harness.calls.touchSingle.length, 0);
  assert.equal(harness.recognizer.pointerDown({ pointerId: 9, pointerType: 'mouse', button: 0 }), false);
});

test('recognizes player controls and form elements as blocked gesture targets', () => {
  assert.equal(isPlayerGestureBlockedTarget({ closest: (selector) => selector.includes('.player-controls') ? {} : null }), true);
  assert.equal(isPlayerGestureBlockedTarget({ closest: () => null }), false);
  assert.equal(isPlayerGestureBlockedTarget(null), false);
});
