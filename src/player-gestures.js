export const PLAYER_GESTURE_CONFIG = Object.freeze({
  doubleTapDelay: 300,
  maximumTapDuration: 350,
  maximumTapMovement: 16,
  maximumDoubleTapDistance: 48,
  touchSeekSeconds: 10,
  feedbackDuration: 650,
});

const BLOCKED_TARGET_SELECTOR = [
  '.player-controls',
  'button',
  'input',
  'select',
  'textarea',
  'label',
  'dialog',
  '[contenteditable="true"]',
].join(', ');

const coordinate = (event, primary, fallback) => {
  const value = Number(event?.[primary] ?? event?.[fallback]);
  return Number.isFinite(value) ? value : 0;
};

const distance = (first, second) => Math.hypot(first.x - second.x, first.y - second.y);

export function isPlayerGestureBlockedTarget(target) {
  return Boolean(target?.closest?.(BLOCKED_TARGET_SELECTOR));
}

export function createPlayerGestureRecognizer({
  onMouseSingle = () => {},
  onMouseDouble = () => {},
  onTouchSingle = () => {},
  onTouchDouble = () => true,
  now = Date.now,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
  config = PLAYER_GESTURE_CONFIG,
} = {}) {
  let activePointer = null;
  let pendingTap = null;
  let destroyed = false;

  function clearPendingTimer() {
    if (pendingTap?.timer !== null && pendingTap?.timer !== undefined) clearTimeoutImpl(pendingTap.timer);
  }

  function runSingle(tap) {
    if (destroyed || !tap) return;
    if (tap.pointerType === 'mouse') onMouseSingle(tap);
    else if (tap.pointerType === 'touch') onTouchSingle(tap);
  }

  function scheduleSingle(tap) {
    const pending = { ...tap, timer: null };
    pending.timer = setTimeoutImpl(() => {
      if (pendingTap !== pending) return;
      pendingTap = null;
      runSingle(pending);
    }, config.doubleTapDelay);
    pendingTap = pending;
  }

  function finishTap(tap) {
    if (!pendingTap) {
      scheduleSingle(tap);
      return;
    }

    const previous = pendingTap;
    const isSameType = previous.pointerType === tap.pointerType;
    const isClose = distance(previous, tap) <= config.maximumDoubleTapDistance;
    const isSameTouchZone = tap.pointerType !== 'touch' || previous.zone === tap.zone;

    if (isSameType && isClose && isSameTouchZone) {
      clearPendingTimer();
      pendingTap = null;
      if (tap.pointerType === 'mouse') {
        onMouseDouble(tap);
      } else if (onTouchDouble(tap) === false) {
        onTouchSingle(tap);
      }
      return;
    }

    clearPendingTimer();
    pendingTap = null;
    runSingle(previous);
    scheduleSingle(tap);
  }

  function pointerDown(event) {
    if (destroyed) return false;
    const pointerType = event?.pointerType;
    if (!['mouse', 'touch'].includes(pointerType)) return false;
    if (pointerType === 'mouse' && Number(event?.button) !== 0) return false;
    if (event?.isPrimary === false) {
      activePointer = null;
      return false;
    }
    if (activePointer && activePointer.pointerId !== event.pointerId) {
      activePointer = null;
      return false;
    }

    const x = coordinate(event, 'clientX', 'x');
    const y = coordinate(event, 'clientY', 'y');
    activePointer = {
      pointerId: event?.pointerId,
      pointerType,
      x,
      y,
      zone: event?.zone,
      startedAt: now(),
      maximumMovement: 0,
    };
    return true;
  }

  function pointerMove(event) {
    if (destroyed || !activePointer || activePointer.pointerId !== event?.pointerId) return false;
    const point = {
      x: coordinate(event, 'clientX', 'x'),
      y: coordinate(event, 'clientY', 'y'),
    };
    activePointer.maximumMovement = Math.max(activePointer.maximumMovement, distance(activePointer, point));
    return true;
  }

  function pointerUp(event) {
    if (destroyed || !activePointer || activePointer.pointerId !== event?.pointerId) return false;
    const pointer = activePointer;
    pointerMove(event);
    activePointer = null;
    if (now() - pointer.startedAt > config.maximumTapDuration) return false;
    if (pointer.maximumMovement > config.maximumTapMovement) return false;

    finishTap({
      pointerType: pointer.pointerType,
      x: coordinate(event, 'clientX', 'x'),
      y: coordinate(event, 'clientY', 'y'),
      zone: event?.zone ?? pointer.zone,
    });
    return true;
  }

  function pointerCancel(event) {
    if (!activePointer || activePointer.pointerId !== event?.pointerId) return false;
    activePointer = null;
    return true;
  }

  function reset() {
    clearPendingTimer();
    pendingTap = null;
    activePointer = null;
  }

  function destroy() {
    reset();
    destroyed = true;
  }

  return Object.freeze({ pointerDown, pointerMove, pointerUp, pointerCancel, reset, destroy });
}
