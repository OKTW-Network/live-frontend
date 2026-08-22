import { clamp, finiteOr, forwardBufferFor, latestRangeEnd, readRanges } from './shared.js';

export function createCatchUp({
  state,
  getVideo,
  getHls,
  pushDebug,
  emitSnapshot,
  setIntervalImpl,
  clearIntervalImpl,
} = {}) {
  let liveTimer = null;
  let latencySamples = [];

  function updateLiveMetrics() {
    const currentVideo = getVideo();
    const hls = getHls();
    const buffered = readRanges(currentVideo.buffered);
    const currentTime = finiteOr(currentVideo.currentTime);
    state.forwardBuffer = forwardBufferFor(buffered, currentTime);
    if (state.mode !== 'live') {
      state.latency = null;
      state.targetLatency = null;
      return;
    }
    if (state.engine === 'hls' && hls) {
      state.latency = Number.isFinite(hls.latency) ? hls.latency : null;
      state.targetLatency = Number.isFinite(hls.targetLatency) ? hls.targetLatency : null;
      return;
    }
    const liveEdge = latestRangeEnd(buffered);
    state.latency = liveEdge === null ? null : Math.max(0, liveEdge - currentTime);
  }

  function autoCatchUpEligible() {
    const currentVideo = getVideo();
    return state.mode === 'live' && state.autoCatchUp && state.selectedRate === 1 && state.following
      && currentVideo.paused === false && !state.waiting;
  }

  function stopCatchUp(reason) {
    const currentVideo = getVideo();
    const hls = getHls();
    const previous = finiteOr(currentVideo.playbackRate, 1);
    if (hls?.config) hls.config.maxLiveSyncPlaybackRate = 1;
    if (state.selectedRate === 1 && previous !== 1) {
      try { currentVideo.playbackRate = 1; } catch { /* Browser may reject rates. */ }
    }
    if (state.catchUpActive || state.catchUpReason !== reason) {
      state.catchUpActive = false;
      state.catchUpReason = reason;
      pushDebug('player', 'info', 'CATCH_UP_CHANGED', { active: false, reason, effectiveRate: currentVideo.playbackRate });
    }
  }

  function applyRatePolicy(reason) {
    const currentVideo = getVideo();
    const hls = getHls();
    if (state.mode !== 'live') {
      try { currentVideo.playbackRate = state.selectedRate; } catch {}
      return;
    }
    if (state.engine === 'hls' && hls?.config) {
      const enabled = autoCatchUpEligible();
      hls.config.maxLiveSyncPlaybackRate = enabled ? 1.25 : 1;
      if (!enabled) {
        try { currentVideo.playbackRate = state.selectedRate; } catch {}
        if (state.catchUpActive) stopCatchUp(reason);
      }
      return;
    }
    if (!autoCatchUpEligible()) stopCatchUp(reason);
  }

  function nativeCatchUpTick() {
    const currentVideo = getVideo();
    updateLiveMetrics();
    if (state.engine !== 'native' || !autoCatchUpEligible()) {
      applyRatePolicy('not-eligible');
      emitSnapshot();
      return;
    }
    if (state.targetLatency === null && state.latency !== null && state.forwardBuffer > 1) {
      latencySamples.push(state.latency);
      latencySamples = latencySamples.slice(-5);
      if (latencySamples.length === 5 && Math.max(...latencySamples) - Math.min(...latencySamples) <= 1) {
        const sorted = [...latencySamples].sort((a, b) => a - b);
        state.targetLatency = clamp(sorted[2], 1, 10);
        pushDebug('player', 'info', 'TARGET_LATENCY_ESTABLISHED', { samples: latencySamples, target: state.targetLatency });
      }
    }
    if (state.targetLatency === null || state.latency === null) {
      emitSnapshot();
      return;
    }
    if (state.forwardBuffer <= 1) stopCatchUp('forward-buffer-low');
    else if (state.latency > state.targetLatency + 1) {
      if (finiteOr(currentVideo.playbackRate, 1) !== 1.25) currentVideo.playbackRate = 1.25;
      if (!state.catchUpActive) {
        state.catchUpActive = true;
        state.catchUpReason = 'latency-high';
        pushDebug('player', 'info', 'CATCH_UP_CHANGED', { active: true, reason: state.catchUpReason });
      }
    } else if (Math.abs(state.latency - state.targetLatency) <= 0.25) stopCatchUp('target-reached');
    emitSnapshot();
  }

  function liveTick() {
    const currentVideo = getVideo();
    if (state.engine === 'native') return nativeCatchUpTick();
    updateLiveMetrics();
    const effective = finiteOr(currentVideo.playbackRate, 1);
    const active = autoCatchUpEligible() && effective > 1.001;
    if (active !== state.catchUpActive) {
      state.catchUpActive = active;
      state.catchUpReason = active ? 'hls-latency-controller' : 'hls-rate-normal';
      pushDebug('player', 'info', 'CATCH_UP_CHANGED', { active, reason: state.catchUpReason, effectiveRate: effective });
    }
    emitSnapshot();
  }

  function updateFollowingAfterSeek() {
    const currentVideo = getVideo();
    if (state.mode !== 'live') return;
    const end = latestRangeEnd(readRanges(currentVideo.buffered));
    const next = end !== null && end - finiteOr(currentVideo.currentTime) <= 2;
    if (next !== state.following) {
      state.following = next;
      state.catchUpReason = next ? 'seek-near-live-edge' : 'dvr-seek';
      pushDebug('player', 'info', 'FOLLOWING_CHANGED', { following: next, reason: state.catchUpReason });
    }
    applyRatePolicy(state.catchUpReason);
  }

  function startLiveTimer() {
    if (liveTimer || !setIntervalImpl) return;
    liveTimer = setIntervalImpl(liveTick, 500);
  }

  function clearLiveTimer() {
    if (liveTimer) clearIntervalImpl?.(liveTimer);
    liveTimer = null;
  }

  function reset() {
    clearLiveTimer();
    latencySamples = [];
    state.targetLatency = null;
    state.latency = null;
    state.forwardBuffer = 0;
    state.catchUpActive = false;
  }

  return {
    updateLiveMetrics,
    autoCatchUpEligible,
    applyRatePolicy,
    stopCatchUp,
    nativeCatchUpTick,
    liveTick,
    updateFollowingAfterSeek,
    startLiveTimer,
    clearLiveTimer,
    reset,
  };
}
