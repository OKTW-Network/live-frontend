import { liveUrl, recordUrl } from '../utils.js';
import { createDebugLog, serializePayload } from './debug.js';
import {
  MEDIA_EVENTS,
  STORAGE_KEYS,
  clamp,
  defaultMessage,
  finiteOr,
  forwardBufferFor,
  latestRangeEnd,
  readPreference,
  readRanges,
  writePreference,
} from './shared.js';

export const PLAYER_RATES = Object.freeze([0.25, 0.5, 0.75, 1, 2, 4, 8, 16]);
export const LIVE_LATENCY_PROFILES = Object.freeze({
  low: Object.freeze({
    lowLatencyMode: true,
    liveSyncDurationCount: 1,
    liveMaxLatencyDurationCount: 3,
    initialLiveManifestSize: 1,
    maxLiveSyncPlaybackRate: 1.25,
  }),
  stable: Object.freeze({
    lowLatencyMode: false,
    liveSyncDurationCount: 3,
    liveMaxLatencyDurationCount: 6,
    initialLiveManifestSize: 3,
    maxLiveSyncPlaybackRate: 1,
  }),
});

const LIVE_POSITION_TOLERANCE = 1.5;
const MIN_CATCH_UP_FORWARD_BUFFER = 2;
const MIN_LIVE_POSITION_FORWARD_BUFFER = 0.25;
const NATIVE_MAX_LATENCY_SECONDS = Object.freeze({ low: 12, stable: 30 });

export const INITIAL_PLAYER_SNAPSHOT = {
  mode: null, engine: 'none', source: '', sourceUrl: '', playerState: 'idle',
  networkState: 0, readyState: 0, paused: true, playing: false, ended: false,
  userPaused: false, hasPlayed: false, currentTime: 0, duration: null,
  buffered: [], seekable: [], timelineStart: 0, timelineEnd: 0, canSeek: false,
  livePosition: null, atLiveEdge: false, lowLatency: true,
  selectedRate: 1, effectiveRate: 1, following: false,
  catchUpActive: false, catchUpReason: 'idle', latency: null, targetLatency: null, forwardBuffer: 0,
  volumePercent: 100, preferredVolumePercent: 100, muted: false, muteReason: 'none',
  boostEnabled: false, boostAvailable: false, boostUnavailableReason: '', gain: 1,
  audioContextState: 'not-created', autoplayState: 'idle', lastPlayResult: null,
  pip: false, fullscreen: false, shareStatus: '', message: '', lastError: null, debugCount: 0,
  capabilities: { boost: false, pictureInPicture: false, fullscreen: false, share: false },
};

export function createPlayerController({
  video,
  container,
  getHls = () => globalThis.Hls,
  storage = globalThis.localStorage,
  environment = {},
  onSnapshot = () => {},
  onDebug = () => {},
} = {}) {
  if (!video) throw new TypeError('createPlayerController requires a video element');
  if (!container) throw new TypeError('createPlayerController requires a player container');

  const documentImpl = environment.document ?? globalThis.document;
  const navigatorImpl = environment.navigator ?? globalThis.navigator ?? {};
  const locationImpl = environment.location ?? globalThis.location ?? { href: 'http://localhost/' };
  const fetchImpl = environment.fetch ?? globalThis.fetch;
  const AudioContextImpl = environment.AudioContext ?? globalThis.AudioContext ?? globalThis.webkitAudioContext;
  const setIntervalImpl = environment.setInterval ?? globalThis.setInterval;
  const clearIntervalImpl = environment.clearInterval ?? globalThis.clearInterval;

  const storedVolume = clamp(finiteOr(readPreference(storage, STORAGE_KEYS.volume, 100), 100), 0, 200);
  const storedRate = Number(readPreference(storage, STORAGE_KEYS.rate, 1));
  let preferredVolume = storedVolume;
  let lastAudibleVolume = storedVolume > 0 ? storedVolume : 100;
  let hls = null;
  let currentVideo = video;
  let sourceGeneration = 0;
  let sourceCleanups = [];
  let globalCleanups = [];
  let pendingTimecode = null;
  let autoplayAttempted = false;
  let mediaRecoveryAttempted = false;
  let suppressPauseEvent = false;
  let lastSnapshot = null;
  let destroyed = false;

  let audioContext = null;
  let audioSource = null;
  let gainNode = null;
  let audioSourceVideo = null;
  let nativeCorsFallbackAttempted = false;

  let liveTimer = null;

  const state = {
    mode: null,
    engine: 'none',
    source: '',
    sourceUrl: '',
    playerState: 'idle',
    autoplayState: 'idle',
    lastPlayResult: null,
    lastError: null,
    notice: '',
    muteReason: storedVolume === 0 ? 'volume-zero' : 'none',
    boostEnabled: readPreference(storage, STORAGE_KEYS.boost, 'false') === 'true',
    boostAvailable: false,
    boostUnavailableReason: AudioContextImpl ? '尚未載入可用來源' : '瀏覽器不支援 Web Audio',
    selectedRate: PLAYER_RATES.includes(storedRate) ? storedRate : 1,
    lowLatency: readPreference(storage, STORAGE_KEYS.lowLatency, 'true') !== 'false',
    following: false,
    targetLatency: null,
    latency: null,
    forwardBuffer: 0,
    catchUpActive: false,
    catchUpReason: 'idle',
    userPaused: false,
    wasPlayingBeforeHidden: false,
    hasPlayed: false,
    shareStatus: '',
  };

  const debugLog = createDebugLog({ now: Date.now, onDebug });
  const pushDebug = (...args) => debugLog.push(...args);

  function listen(target, type, handler, options, collection = sourceCleanups) {
    if (!target?.addEventListener) return;
    target.addEventListener(type, handler, options);
    collection.push(() => target.removeEventListener?.(type, handler, options));
  }

  function effectiveVolume() {
    return clamp(preferredVolume, 0, state.boostEnabled && state.boostAvailable ? 200 : 100);
  }

  function applyVolume() {
    const volume = effectiveVolume();
    if (gainNode?.gain) gainNode.gain.value = volume / 100;
    currentVideo.volume = audioSourceVideo === currentVideo && gainNode ? 1 : clamp(volume / 100, 0, 1);
  }

  function setBoostCapability(allowed, reason = '') {
    state.boostAvailable = Boolean(allowed && AudioContextImpl);
    state.boostUnavailableReason = state.boostAvailable
      ? ''
      : reason || (AudioContextImpl ? '來源未開放 Web Audio' : '瀏覽器不支援 Web Audio');
    applyVolume();
  }

  function disconnectAudio() {
    try { audioSource?.disconnect?.(); } catch {}
    try { gainNode?.disconnect?.(); } catch {}
    audioSource = null;
    gainNode = null;
    audioSourceVideo = null;
  }

  function replaceVideoForNativeAudio() {
    if (!audioSource || audioSourceVideo !== currentVideo || !currentVideo.cloneNode) return false;
    const replacement = currentVideo.cloneNode(true);
    replacement.removeAttribute?.('src');
    replacement.removeAttribute?.('crossorigin');
    replacement.src = '';
    replacement.muted = currentVideo.muted;
    const parent = currentVideo.parentNode;
    if (!parent?.replaceChild) return false;
    sourceCleanups.forEach((remove) => remove());
    sourceCleanups = [];
    const previous = currentVideo;
    disconnectAudio();
    parent.replaceChild(replacement, previous);
    currentVideo = replacement;
    pushDebug('audio', 'warn', 'MEDIA_ELEMENT_REPLACED', { reason: 'cors-native-fallback' });
    return true;
  }

  function ensureGraph() {
    if (!state.boostAvailable || !AudioContextImpl) return null;
    try {
      if (!audioContext || audioContext.state === 'closed') {
        audioContext = new AudioContextImpl();
        const handleStateChange = () => {
          const event = audioContext.state === 'running' ? 'AUDIO_CONTEXT_RESUME' : 'AUDIO_CONTEXT_SUSPEND';
          pushDebug('audio', 'info', event, { state: audioContext.state });
          emitSnapshot();
        };
        listen(audioContext, 'statechange', handleStateChange, undefined, globalCleanups);
        pushDebug('audio', 'info', 'AUDIO_CONTEXT_CREATED', { state: audioContext.state });
      }
      if (!audioSource || audioSourceVideo !== currentVideo) {
        disconnectAudio();
        audioSource = audioContext.createMediaElementSource(currentVideo);
        gainNode = audioContext.createGain();
        audioSource.connect(gainNode);
        gainNode.connect(audioContext.destination);
        audioSourceVideo = currentVideo;
        applyVolume();
        pushDebug('audio', 'info', 'AUDIO_GRAPH_CREATED', { gain: gainNode.gain?.value });
      }
      return audioContext;
    } catch (error) {
      setBoostCapability(false, '無法建立 Web Audio 音訊圖');
      state.lastError = { name: error?.name || 'AudioError', message: error?.message || String(error) };
      pushDebug('audio', 'error', 'AUDIO_GRAPH_ERROR', state.lastError);
      return null;
    }
  }

  function startActivation() {
    const context = ensureGraph();
    if (!context) return Promise.resolve({ required: false, running: true });
    pushDebug('audio', 'info', 'AUDIO_CONTEXT_RESUME_ATTEMPT', { state: context.state });
    let result;
    try { result = context.resume?.(); } catch (error) { result = Promise.reject(error); }
    return Promise.resolve(result)
      .then(() => ({ required: true, running: context.state === 'running' }))
      .catch((error) => {
        pushDebug('audio', 'error', 'AUDIO_CONTEXT_RESUME_FAILED', error);
        return { required: true, running: false, error };
      });
  }

  async function probeCors(url) {
    let parsed;
    try {
      parsed = new URL(url, locationImpl.href);
      const page = new URL(locationImpl.href);
      if (parsed.origin === page.origin) return { allowed: true, crossOrigin: false };
    } catch {
      return { allowed: false, crossOrigin: false };
    }
    if (!fetchImpl) return { allowed: false, crossOrigin: false };
    try {
      const response = await fetchImpl(parsed.href, {
        method: 'GET', mode: 'cors', cache: 'no-store', headers: { Range: 'bytes=0-0' },
      });
      try { await response.body?.cancel?.(); } catch { /* Response may not expose a body. */ }
      return { allowed: Boolean(response.ok), crossOrigin: Boolean(response.ok) };
    } catch (error) {
      pushDebug('audio', 'warn', 'CORS_PROBE_FAILED', { url, error });
      return { allowed: false, crossOrigin: false };
    }
  }

  async function configureNativeSource(url, generation) {
    const cors = await probeCors(url);
    if (generation !== sourceGeneration || destroyed) return false;
    const replaced = !cors.allowed && audioSourceVideo === currentVideo && replaceVideoForNativeAudio();
    if (replaced) bindMediaEvents();
    if (cors.crossOrigin) {
      currentVideo.crossOrigin = 'anonymous';
      currentVideo.setAttribute?.('crossorigin', 'anonymous');
    } else {
      currentVideo.removeAttribute?.('crossorigin');
      try { currentVideo.crossOrigin = null; } catch {}
    }
    setBoostCapability(cors.allowed, cors.allowed ? '' : '跨來源影音未開放 CORS，僅支援 0–100%');
    return true;
  }

  function handleNativeCorsFailure() {
    if (state.engine !== 'native' || !currentVideo.crossOrigin || nativeCorsFallbackAttempted) return false;
    nativeCorsFallbackAttempted = true;
    const url = state.sourceUrl;
    pushDebug('audio', 'warn', 'CORS_MEDIA_FALLBACK', { url });
    const replaced = audioSourceVideo === currentVideo && replaceVideoForNativeAudio();
    currentVideo.removeAttribute?.('crossorigin');
    try { currentVideo.crossOrigin = null; } catch {}
    setBoostCapability(false, '跨來源影音未開放 CORS，已使用原生音量');
    if (replaced) bindMediaEvents();
    currentVideo.src = url;
    currentVideo.load?.();
    return true;
  }

  async function closeAudio() {
    disconnectAudio();
    if (audioContext && audioContext.state !== 'closed') {
      try { await audioContext.close?.(); } catch { /* Best-effort close. */ }
    }
  }

  function resetCorsFallback() {
    nativeCorsFallbackAttempted = false;
  }

  function updateLiveMetrics() {
    const buffered = readRanges(currentVideo.buffered);
    const seekable = readRanges(currentVideo.seekable);
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
    if (state.engine !== 'native') {
      state.latency = null;
      state.targetLatency = null;
      return;
    }
    const liveEdge = latestRangeEnd(seekable) ?? latestRangeEnd(buffered);
    state.latency = liveEdge === null ? null : Math.max(0, liveEdge - currentTime);
    state.targetLatency = state.lowLatency ? 1 : null;
  }

  function latencyProfile() {
    return state.lowLatency ? LIVE_LATENCY_PROFILES.low : LIVE_LATENCY_PROFILES.stable;
  }

  function livePositionFor(seekable = readRanges(currentVideo.seekable)) {
    if (state.mode !== 'live') return null;
    const hlsPosition = state.engine === 'hls' ? Number(hls?.liveSyncPosition) : Number.NaN;
    const first = seekable[0]?.start;
    const last = latestRangeEnd(seekable);
    if (Number.isFinite(hlsPosition)) {
      return last === null ? hlsPosition : clamp(hlsPosition, first, last);
    }
    return last === null ? null : Math.max(first, last - 0.25);
  }

  function atLivePosition(position = livePositionFor()) {
    return position !== null && finiteOr(currentVideo.currentTime) >= position - LIVE_POSITION_TOLERANCE;
  }

  function livePositionBuffered(position = livePositionFor()) {
    return position !== null && readRanges(currentVideo.buffered)
      .some(({ start, end }) => position >= start && end - position >= MIN_LIVE_POSITION_FORWARD_BUFFER);
  }

  function catchUpEligible() {
    const livePosition = livePositionFor();
    return state.mode === 'live' && state.lowLatency && state.selectedRate === 1 && state.following
      && currentVideo.paused === false && state.playerState !== 'waiting'
      && livePosition !== null && livePosition - finiteOr(currentVideo.currentTime) > LIVE_POSITION_TOLERANCE
      && state.forwardBuffer >= MIN_CATCH_UP_FORWARD_BUFFER;
  }

  function stopCatchUp(reason) {
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
    if (state.mode !== 'live') {
      try { currentVideo.playbackRate = state.selectedRate; } catch {}
      return;
    }
    if (state.engine === 'hls' && hls?.config) {
      const enabled = catchUpEligible();
      hls.config.liveMaxLatencyDurationCount = state.following && livePositionBuffered()
        ? latencyProfile().liveMaxLatencyDurationCount
        : Number.POSITIVE_INFINITY;
      hls.config.maxLiveSyncPlaybackRate = enabled ? latencyProfile().maxLiveSyncPlaybackRate : 1;
      if (!enabled) {
        try { currentVideo.playbackRate = state.selectedRate; } catch {}
        stopCatchUp(reason);
      }
      return;
    }
    if (!catchUpEligible()) stopCatchUp(reason);
  }

  function nativeCatchUpTick() {
    updateLiveMetrics();
    if (state.mode === 'live' && state.following && currentVideo.paused === false && livePositionBuffered()
      && state.latency !== null
      && state.latency > NATIVE_MAX_LATENCY_SECONDS[state.lowLatency ? 'low' : 'stable']) {
      goLive({ requireBuffered: true });
      return;
    }
    if (state.engine !== 'native' || !catchUpEligible()) {
      applyRatePolicy('not-eligible');
      emitSnapshot();
      return;
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
    if (state.engine === 'native') return nativeCatchUpTick();
    updateLiveMetrics();
    const maximumLatency = Number.isFinite(Number(hls?.maxLatency))
      ? Number(hls.maxLatency)
      : state.targetLatency === null
        ? null
        : state.targetLatency * (latencyProfile().liveMaxLatencyDurationCount / latencyProfile().liveSyncDurationCount);
    if (state.following && currentVideo.paused === false && livePositionBuffered()
      && state.latency !== null && maximumLatency !== null
      && state.latency > maximumLatency) {
      goLive({ requireBuffered: true });
      return;
    }
    const catchUpReason = atLivePosition()
      ? 'live-edge'
      : state.forwardBuffer < MIN_CATCH_UP_FORWARD_BUFFER
        ? 'forward-buffer-low'
        : 'live-tick';
    applyRatePolicy(catchUpReason);
    const effective = finiteOr(currentVideo.playbackRate, 1);
    const active = catchUpEligible() && effective > 1.001;
    if (active !== state.catchUpActive) {
      state.catchUpActive = active;
      state.catchUpReason = active ? 'hls-latency-controller' : 'hls-rate-normal';
      pushDebug('player', 'info', 'CATCH_UP_CHANGED', { active, reason: state.catchUpReason, effectiveRate: effective });
    }
    emitSnapshot();
  }

  function updateFollowingAfterSeek() {
    if (state.mode !== 'live') return;
    const position = livePositionFor();
    const next = atLivePosition(position);
    if (next !== state.following) {
      state.following = next;
      state.catchUpReason = next ? 'seek-near-live-edge' : 'dvr-seek';
      pushDebug('player', 'info', 'FOLLOWING_CHANGED', { following: next, livePosition: position, reason: state.catchUpReason });
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

  function resetCatchUp() {
    clearLiveTimer();
    state.targetLatency = null;
    state.latency = null;
    state.forwardBuffer = 0;
    state.catchUpActive = false;
  }

  function buildSnapshot() {
    updateLiveMetrics();
    const buffered = readRanges(currentVideo.buffered);
    const seekable = readRanges(currentVideo.seekable);
    const timelineStart = seekable.length ? seekable[0].start : 0;
    const duration = Number(currentVideo.duration);
    const livePosition = livePositionFor(seekable);
    const timelineEnd = state.mode === 'live' && livePosition !== null
      ? livePosition
      : seekable.length
        ? seekable[seekable.length - 1].end
      : Number.isFinite(duration) ? Math.max(0, duration) : 0;
    const volume = effectiveVolume();
    return {
      mode: state.mode,
      engine: state.engine,
      source: state.source,
      sourceUrl: state.sourceUrl,
      playerState: state.playerState,
      networkState: finiteOr(currentVideo.networkState),
      readyState: finiteOr(currentVideo.readyState),
      paused: currentVideo.paused !== false,
      playing: currentVideo.paused === false && !currentVideo.ended,
      ended: Boolean(currentVideo.ended),
      userPaused: state.userPaused,
      hasPlayed: state.hasPlayed,
      currentTime: finiteOr(currentVideo.currentTime),
      duration: Number.isFinite(duration) ? duration : null,
      buffered,
      seekable,
      timelineStart,
      timelineEnd,
      canSeek: timelineEnd > timelineStart && (state.mode !== 'live' || seekable.length > 0),
      livePosition,
      atLiveEdge: atLivePosition(livePosition),
      lowLatency: state.lowLatency,
      selectedRate: state.selectedRate,
      effectiveRate: finiteOr(currentVideo.playbackRate, 1),
      following: state.following,
      catchUpActive: state.catchUpActive,
      catchUpReason: state.catchUpReason,
      latency: state.latency,
      targetLatency: state.targetLatency,
      forwardBuffer: state.forwardBuffer,
      volumePercent: volume,
      preferredVolumePercent: preferredVolume,
      muted: Boolean(currentVideo.muted),
      muteReason: state.muteReason,
      boostEnabled: state.boostEnabled,
      boostAvailable: state.boostAvailable,
      boostUnavailableReason: state.boostUnavailableReason,
      gain: gainNode?.gain ? finiteOr(gainNode.gain.value, volume / 100) : volume / 100,
      audioContextState: audioContext?.state || (AudioContextImpl ? 'not-created' : 'unavailable'),
      autoplayState: state.autoplayState,
      lastPlayResult: state.lastPlayResult,
      pip: documentImpl?.pictureInPictureElement === currentVideo,
      fullscreen: documentImpl?.fullscreenElement === container,
      shareStatus: state.shareStatus,
      message: defaultMessage(state),
      lastError: state.lastError,
      debugCount: debugLog.count,
      capabilities: {
        boost: state.boostAvailable,
        pictureInPicture: Boolean(documentImpl?.pictureInPictureEnabled && currentVideo.requestPictureInPicture),
        fullscreen: Boolean(container.requestFullscreen && documentImpl?.fullscreenEnabled !== false),
        share: Boolean(navigatorImpl.share || navigatorImpl.clipboard?.writeText),
      },
    };
  }

  function emitSnapshot() {
    if (destroyed) return lastSnapshot;
    lastSnapshot = buildSnapshot();
    try { onSnapshot(lastSnapshot); } catch { /* Rendering callbacks must not break playback. */ }
    return lastSnapshot;
  }

  function setVideoMuted(muted, reason) {
    state.muteReason = muted ? reason : 'none';
    currentVideo.muted = Boolean(muted);
    pushDebug('player', 'info', 'MUTE_CHANGED', { muted: currentVideo.muted, reason: state.muteReason });
  }

  function requestVideoPlay() {
    try { return Promise.resolve(currentVideo.play?.()); } catch (error) { return Promise.reject(error); }
  }

  async function userActivatedPlay({ unmute = false, reason = 'manual-play' } = {}) {
    state.notice = '';
    state.userPaused = false;
    if (state.mode === 'live' && currentVideo.paused !== false) {
      state.playerState = 'loading';
      emitSnapshot();
    }
    const generation = sourceGeneration;
    const audioPromise = startActivation();
    const playPromise = requestVideoPlay();
    pushDebug('player', 'info', 'PLAY_ATTEMPT', { reason, unmute });
    const [audioResult, playResult] = await Promise.allSettled([audioPromise, playPromise]);
    if (generation !== sourceGeneration || destroyed) return false;

    const audioOutcome = audioResult.status === 'fulfilled' ? audioResult.value : { required: true, running: false };
    if (unmute) {
      if (audioOutcome.required && !audioOutcome.running) {
        setVideoMuted(true, 'audio-context-blocked');
        state.notice = '再次點擊以啟用聲音';
      } else {
        setVideoMuted(false, 'none');
      }
    }

    if (playResult.status === 'fulfilled') {
      state.lastPlayResult = { ok: true, reason };
      state.playerState = 'playing';
      state.autoplayState = 'manual';
      state.userPaused = false;
      state.hasPlayed = true;
      pushDebug('player', 'info', 'PLAY_SUCCESS', { reason });
      applyRatePolicy('manual-play');
      emitSnapshot();
      return true;
    }

    const error = playResult.reason;
    state.lastPlayResult = { ok: false, name: error?.name || 'Error', message: error?.message || String(error), reason };
    state.lastError = state.lastPlayResult;
    state.playerState = error?.name === 'NotAllowedError'
      ? 'ready'
      : error?.name === 'NotSupportedError' ? 'unsupported' : 'error';
    pushDebug('player', 'error', 'PLAY_FAILED', state.lastPlayResult);
    emitSnapshot();
    return false;
  }

  async function attemptMutedAutoplay() {
    if (autoplayAttempted || state.mode !== 'live') return false;
    autoplayAttempted = true;
    const generation = sourceGeneration;
    setVideoMuted(true, 'autoplay');
    state.playerState = 'loading';
    state.autoplayState = 'attempting-muted';
    state.lastPlayResult = null;
    pushDebug('autoplay', 'info', 'AUTOPLAY_ATTEMPT', { muted: true });
    emitSnapshot();
    try {
      await requestVideoPlay();
      if (generation !== sourceGeneration || destroyed) return false;
      state.autoplayState = 'playing-muted';
      state.playerState = 'playing';
      state.lastPlayResult = { ok: true, reason: 'autoplay-muted' };
      state.userPaused = false;
      state.hasPlayed = true;
      pushDebug('autoplay', 'info', 'AUTOPLAY_SUCCESS', { muted: true });
      emitSnapshot();
      return true;
    } catch (error) {
      if (generation !== sourceGeneration || destroyed) return false;
      state.lastPlayResult = { ok: false, name: error?.name || 'Error', message: error?.message || String(error), reason: 'autoplay-muted' };
      if (error?.name === 'NotAllowedError') {
        state.autoplayState = 'blocked';
        state.playerState = 'ready';
        pushDebug('autoplay', 'warn', 'AUTOPLAY_BLOCKED', state.lastPlayResult);
      } else {
        state.autoplayState = 'idle';
        state.playerState = error?.name === 'NotSupportedError'
          ? 'unsupported'
          : state.mode === 'live' ? 'offline' : 'error';
        state.lastError = state.lastPlayResult;
        pushDebug('autoplay', 'error', 'AUTOPLAY_FAILED', state.lastPlayResult);
      }
      emitSnapshot();
      return false;
    }
  }

  function parseTimecode(value) {
    if (value === null || value === undefined) return null;
    if (String(value).trim() === '') {
      pushDebug('player', 'warn', 'TIMECODE_INVALID', { value, reason: 'empty' });
      return null;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) {
      pushDebug('player', 'warn', 'TIMECODE_INVALID', { value, reason: 'not-finite-or-negative' });
      return null;
    }
    return Math.floor(numeric);
  }

  function seekPendingTimecode() {
    if (pendingTimecode === null || state.mode !== 'record') return;
    const duration = Number(currentVideo.duration);
    const target = Number.isFinite(duration) ? clamp(pendingTimecode, 0, duration) : pendingTimecode;
    suppressPauseEvent = true;
    currentVideo.pause?.();
    suppressPauseEvent = false;
    try {
      currentVideo.currentTime = target;
      pushDebug('player', 'info', 'TIMECODE_SEEK', { requested: pendingTimecode, target, duration });
      if (Math.abs(finiteOr(currentVideo.currentTime) - target) < 0.01) pendingTimecode = null;
    } catch (error) {
      pushDebug('player', 'error', 'TIMECODE_SEEK_FAILED', error);
      pendingTimecode = null;
    }
    state.playerState = 'ready';
    state.userPaused = true;
    emitSnapshot();
  }

  function handleMediaEvent(type, event) {
    pushDebug('media', type === 'error' ? 'error' : 'debug', type, {
      currentTime: finiteOr(currentVideo.currentTime),
      duration: Number.isFinite(Number(currentVideo.duration)) ? Number(currentVideo.duration) : String(currentVideo.duration),
      readyState: currentVideo.readyState,
      networkState: currentVideo.networkState,
      error: currentVideo.error,
      event,
    });

    if (type === 'loadedmetadata') {
      state.playerState = 'ready';
      if (state.mode === 'record') seekPendingTimecode();
      else if (state.engine === 'native') {
        goLive();
        attemptMutedAutoplay();
      }
    } else if (type === 'playing') {
      state.playerState = 'playing';
      state.userPaused = false;
      state.hasPlayed = true;
      mediaRecoveryAttempted = false;
      applyRatePolicy('playing');
    } else if (type === 'pause') {
      const terminal = ['offline', 'error', 'unsupported'].includes(state.playerState);
      if (!terminal) {
        if (!suppressPauseEvent && documentImpl?.pictureInPictureElement === currentVideo && state.playerState !== 'idle') state.userPaused = true;
        const buffering = state.mode === 'live' && !state.userPaused
          && documentImpl?.visibilityState !== 'hidden' && state.playerState !== 'idle';
        if (buffering) state.playerState = 'waiting';
        else if (state.playerState !== 'idle' && !currentVideo.ended) state.playerState = 'paused';
        applyRatePolicy(buffering ? 'buffering-pause' : 'paused');
      }
    } else if (type === 'waiting' || type === 'stalled') {
      if (!['offline', 'error', 'unsupported'].includes(state.playerState)) {
        state.playerState = state.userPaused ? 'paused' : 'waiting';
      }
      stopCatchUp(type);
    } else if (type === 'canplay' || type === 'progress' || type === 'durationchange') {
      if (state.playerState === 'waiting' && state.mode === 'live' && !state.userPaused) {
        if (currentVideo.paused === false) {
          state.playerState = 'playing';
          applyRatePolicy('buffer-resumed');
        } else {
          state.playerState = 'loading';
          if (livePositionBuffered()) goLive({ requireBuffered: true });
          const generation = sourceGeneration;
          requestVideoPlay().then(() => {
            if (generation !== sourceGeneration || destroyed) return;
            state.playerState = 'playing';
            state.hasPlayed = true;
            state.lastPlayResult = { ok: true, reason: 'buffer-resume' };
            applyRatePolicy('buffer-resumed');
            emitSnapshot();
          }).catch((error) => {
            if (generation !== sourceGeneration || destroyed) return;
            state.playerState = 'waiting';
            state.lastPlayResult = { ok: false, name: error?.name || 'Error', message: error?.message || String(error), reason: 'buffer-resume' };
            pushDebug('autoplay', 'warn', 'BUFFER_RESUME_FAILED', state.lastPlayResult);
            emitSnapshot();
          });
        }
      } else if (state.playerState === 'waiting') state.playerState = currentVideo.paused ? 'ready' : 'playing';
    } else if (type === 'ended') {
      if (!['offline', 'error', 'unsupported'].includes(state.playerState)) {
        state.playerState = state.mode === 'live' && !state.userPaused ? 'waiting' : 'paused';
        state.userPaused = false;
      }
      stopCatchUp('ended');
    } else if (type === 'error') {
      if (handleNativeCorsFailure()) return;
      state.lastError = serializePayload(currentVideo.error || { message: 'Media element error' });
      state.playerState = Number(currentVideo.error?.code) === 4
        ? 'unsupported'
        : state.mode === 'live' ? 'offline' : 'error';
    } else if (type === 'ratechange') {
      const effective = finiteOr(currentVideo.playbackRate, 1);
      const wasActive = state.catchUpActive;
      state.catchUpActive = state.mode === 'live' && state.selectedRate === 1 && effective > 1.001;
      if (wasActive !== state.catchUpActive) {
        pushDebug('player', 'info', 'CATCH_UP_CHANGED', {
          active: state.catchUpActive,
          reason: state.catchUpReason,
          selectedRate: state.selectedRate,
          effectiveRate: effective,
        });
      }
    } else if (type === 'seeked') {
      pendingTimecode = null;
      updateFollowingAfterSeek();
    } else if (type === 'volumechange') {
      if (!gainNode && Number.isFinite(currentVideo.volume)) preferredVolume = Math.round(currentVideo.volume * 100);
    } else if (type === 'enterpictureinpicture') {
      pushDebug('pip', 'info', 'PIP_ENTER', {});
    } else if (type === 'leavepictureinpicture') {
      pushDebug('pip', 'info', 'PIP_LEAVE', {});
    }
    emitSnapshot();
  }

  function bindMediaEvents() {
    MEDIA_EVENTS.forEach((type) => listen(currentVideo, type, (event) => handleMediaEvent(type, event)));
  }

  function clearSourceResources({ resetMedia = true } = {}) {
    sourceGeneration += 1;
    sourceCleanups.forEach((remove) => remove());
    sourceCleanups = [];
    resetCatchUp();
    if (hls) {
      try { hls.destroy?.(); } catch { /* Best-effort teardown. */ }
      hls = null;
    }
    autoplayAttempted = false;
    mediaRecoveryAttempted = false;
    resetCorsFallback();
    pendingTimecode = null;
    state.following = false;
    if (resetMedia) {
      suppressPauseEvent = true;
      try { currentVideo.pause?.(); } catch {}
      suppressPauseEvent = false;
      currentVideo.removeAttribute?.('src');
      try { currentVideo.src = ''; } catch {}
      try { currentVideo.load?.(); } catch {}
    }
  }

  function initializeSource(mode, source, url, { preserveMute = mode === 'record' } = {}) {
    clearSourceResources();
    const generation = sourceGeneration;
    state.mode = mode;
    state.source = source;
    state.sourceUrl = url;
    state.engine = 'none';
    state.playerState = 'loading';
    state.autoplayState = 'idle';
    state.lastPlayResult = null;
    state.lastError = null;
    state.notice = '';
    state.shareStatus = '';
    state.userPaused = mode === 'record';
    state.hasPlayed = false;
    state.following = mode === 'live';
    setBoostCapability(false, '正在確認來源的 Web Audio 能力');
    currentVideo.playsInline = true;
    currentVideo.setAttribute?.('playsinline', '');
    if (mode === 'live' && !preserveMute) {
      currentVideo.defaultMuted = true;
      currentVideo.setAttribute?.('muted', '');
      setVideoMuted(true, 'new-live');
    }
    try {
      currentVideo.playbackRate = state.selectedRate;
      if (Math.abs(finiteOr(currentVideo.playbackRate, state.selectedRate) - state.selectedRate) > 0.001) throw new Error('Stored playback rate rejected');
    } catch (error) {
      pushDebug('player', 'warn', 'STORED_PLAYBACK_RATE_REJECTED', { requested: state.selectedRate, error });
      state.selectedRate = 1;
      writePreference(storage, STORAGE_KEYS.rate, 1);
      try { currentVideo.playbackRate = 1; } catch { /* The media element is unusable and will report its own error. */ }
    }
    bindMediaEvents();
    pushDebug('player', 'info', 'SOURCE_LOAD', { mode, source, url, preserveMute });
    emitSnapshot();
    return generation;
  }

  function bindHlsEvents(Hls, generation) {
    const observedEvents = [Hls.Events?.MANIFEST_PARSED, Hls.Events?.BUFFER_APPENDED, Hls.Events?.ERROR].filter(Boolean);
    [...new Set(observedEvents)].forEach((eventName) => {
      hls.on(eventName, (_event, data) => {
        if (generation !== sourceGeneration) return;
        const debugPayload = eventName === Hls.Events.MANIFEST_PARSED
          ? {
              levels: data?.levels?.length ?? 0,
              firstLevel: data?.firstLevel,
              audio: data?.audio,
              video: data?.video,
            }
          : {
              fatal: Boolean(data?.fatal),
              type: data?.type,
              details: data?.details,
              error: data?.error,
              reason: data?.reason,
              response: data?.response && {
                code: data.response.code,
                text: data.response.text,
                url: data.response.url,
              },
              fragment: data?.frag && {
                sn: data.frag.sn,
                start: data.frag.start,
                duration: data.frag.duration,
                url: data.frag.url,
              },
            };
        if (eventName !== Hls.Events.BUFFER_APPENDED) {
          pushDebug('hls', data?.fatal ? 'error' : 'debug', eventName, debugPayload);
        }
        if (eventName === Hls.Events.MANIFEST_PARSED) {
          state.playerState = 'ready';
          setBoostCapability(true);
          attemptMutedAutoplay();
        }
        if (eventName === Hls.Events.BUFFER_APPENDED && state.playerState === 'waiting') {
          handleMediaEvent('progress', data);
        }
        if (eventName === Hls.Events.ERROR && data?.fatal) {
          const unsupportedCodec = data.details === Hls.ErrorDetails?.BUFFER_ADD_CODEC_ERROR
            || data.details === 'bufferAddCodecError'
            || data.error?.name === 'NotSupportedError';
          if (data.type === Hls.ErrorTypes?.MEDIA_ERROR && !unsupportedCodec && !mediaRecoveryAttempted) {
            mediaRecoveryAttempted = true;
            state.playerState = 'waiting';
            pushDebug('hls', 'warn', 'HLS_MEDIA_RECOVERY', debugPayload);
            hls?.recoverMediaError?.();
            emitSnapshot();
          } else {
            const failedHls = hls;
            state.lastError = serializePayload(debugPayload);
            state.playerState = unsupportedCodec
              ? 'unsupported'
              : data.type === Hls.ErrorTypes?.NETWORK_ERROR ? 'offline' : 'error';
            state.engine = unsupportedCodec ? 'unsupported' : 'none';
            state.wasPlayingBeforeHidden = false;
            sourceGeneration += 1;
            clearLiveTimer();
            stopCatchUp('hls-fatal');
            hls = null;
            failedHls?.destroy?.();
            emitSnapshot();
          }
        }
      });
    });
  }

  async function loadLive(streamer, options = {}) {
    const url = liveUrl(streamer);
    const generation = initializeSource('live', streamer, url, { preserveMute: Boolean(options.preserveMute) });
    const nativeSupported = Boolean(currentVideo.canPlayType?.('application/vnd.apple.mpegurl'));
    const Hls = getHls?.();
    if (Hls?.isSupported?.()) {
      state.engine = 'hls';
      setBoostCapability(true);
      hls = new Hls({
        enableWorker: true,
        startPosition: -1,
        liveSyncMode: 'buffered',
        ...latencyProfile(),
      });
      bindHlsEvents(Hls, generation);
      hls.attachMedia(currentVideo);
      hls.loadSource(url);
      startLiveTimer();
      pushDebug('player', 'info', 'ENGINE_SELECTED', { engine: 'hls' });
      emitSnapshot();
      return 'hls';
    }
    if (nativeSupported) {
      const configured = await configureNativeSource(url, generation);
      if (!configured || generation !== sourceGeneration) return 'cancelled';
      state.engine = 'native';
      currentVideo.src = url;
      currentVideo.load?.();
      startLiveTimer();
      pushDebug('player', 'info', 'ENGINE_SELECTED', { engine: 'native' });
      emitSnapshot();
      return 'native';
    }

    state.playerState = 'unsupported';
    state.engine = 'unsupported';
    pushDebug('player', 'error', 'ENGINE_UNSUPPORTED', { mode: 'live' });
    emitSnapshot();
    return 'unsupported';
  }

  async function loadRecord(record, { timecode = null } = {}) {
    const url = recordUrl(record.filename);
    const generation = initializeSource('record', record.filename, url, { preserveMute: true });
    pendingTimecode = parseTimecode(timecode);
    const configured = await configureNativeSource(url, generation);
    if (!configured || generation !== sourceGeneration) return 'cancelled';
    state.engine = 'native';
    currentVideo.src = url;
    currentVideo.load?.();
    pushDebug('player', 'info', 'ENGINE_SELECTED', { engine: 'native', record: record.filename });
    emitSnapshot();
    return 'native';
  }

  async function retry() {
    if (!state.mode || !state.source) return 'idle';
    const descriptor = { mode: state.mode, source: state.source };
    const retryTimecode = pendingTimecode ?? finiteOr(currentVideo.currentTime);
    pushDebug('player', 'info', 'SOURCE_RETRY', descriptor);
    if (descriptor.mode === 'live') return loadLive(descriptor.source, { preserveMute: true });
    return loadRecord({ filename: descriptor.source }, { timecode: retryTimecode });
  }

  function play() { return userActivatedPlay({ unmute: false, reason: 'user-play' }); }

  function pause() {
    state.userPaused = true;
    state.notice = '';
    currentVideo.pause?.();
    state.playerState = 'paused';
    pushDebug('player', 'info', 'USER_PAUSE', {});
    applyRatePolicy('user-paused');
    emitSnapshot();
  }

  function seek(seconds) {
    if (!Number.isFinite(Number(seconds))) return false;
    const seekable = readRanges(currentVideo.seekable);
    const duration = Number(currentVideo.duration);
    let target = Number(seconds);
    if (state.mode === 'live' && seekable.length) {
      target = clamp(target, seekable[0].start, livePositionFor(seekable) ?? seekable[seekable.length - 1].end);
    }
    else if (Number.isFinite(duration)) target = clamp(target, 0, duration);
    try { currentVideo.currentTime = target; } catch (error) {
      pushDebug('player', 'error', 'SEEK_FAILED', { target, error });
      return false;
    }
    pushDebug('player', 'info', 'USER_SEEK', { target });
    updateFollowingAfterSeek();
    emitSnapshot();
    return true;
  }

  function goLive({ requireBuffered = false } = {}) {
    const target = livePositionFor();
    if (target === null) return false;
    state.following = true;
    if (requireBuffered && !livePositionBuffered(target)) {
      state.catchUpReason = 'live-position-unbuffered';
      applyRatePolicy(state.catchUpReason);
      pushDebug('player', 'info', 'GO_LIVE_DEFERRED', { target, engine: state.engine });
      emitSnapshot();
      return false;
    }
    const result = seek(target);
    if (result) {
      state.following = true;
      state.catchUpReason = 'go-live';
      pushDebug('player', 'info', 'GO_LIVE', { target, engine: state.engine });
      applyRatePolicy('go-live');
      emitSnapshot();
    }
    return result;
  }

  function setMuted(muted) {
    if (muted) {
      setVideoMuted(true, 'user');
      state.notice = '';
      emitSnapshot();
      return Promise.resolve(true);
    }
    if (preferredVolume <= 0) {
      preferredVolume = lastAudibleVolume || 100;
      writePreference(storage, STORAGE_KEYS.volume, preferredVolume);
      applyVolume();
    }
    return userActivatedPlay({ unmute: true, reason: 'user-unmute' });
  }

  function setVolume(percent) {
    const maximum = state.boostEnabled && state.boostAvailable ? 200 : 100;
    preferredVolume = clamp(finiteOr(percent), 0, maximum);
    if (preferredVolume > 0) lastAudibleVolume = preferredVolume;
    writePreference(storage, STORAGE_KEYS.volume, preferredVolume);
    applyVolume();
    if (preferredVolume === 0) {
      setVideoMuted(true, 'volume-zero');
      const activation = userActivatedPlay({ unmute: false, reason: 'volume-change' });
      emitSnapshot();
      return activation;
    }
    const activation = userActivatedPlay({ unmute: true, reason: 'volume-change' });
    emitSnapshot();
    return activation;
  }

  function setBoost(enabled) {
    if (enabled && !state.boostAvailable) return false;
    state.boostEnabled = Boolean(enabled);
    if (!state.boostEnabled && preferredVolume > 100) {
      preferredVolume = 100;
      lastAudibleVolume = 100;
      writePreference(storage, STORAGE_KEYS.volume, preferredVolume);
    }
    writePreference(storage, STORAGE_KEYS.boost, state.boostEnabled);
    applyVolume();
    pushDebug('audio', 'info', 'BOOST_CHANGED', { enabled: state.boostEnabled, volume: preferredVolume });
    emitSnapshot();
    return true;
  }

  function setPlaybackRate(rate) {
    const requested = Number(rate);
    if (!PLAYER_RATES.includes(requested)) return false;
    const previous = state.selectedRate;
    const previousEffective = finiteOr(currentVideo.playbackRate, 1);
    try {
      if (hls?.config) hls.config.maxLiveSyncPlaybackRate = 1;
      currentVideo.playbackRate = requested;
      if (Math.abs(finiteOr(currentVideo.playbackRate, requested) - requested) > 0.001) throw new Error('Playback rate rejected');
      state.selectedRate = requested;
      state.catchUpActive = false;
      writePreference(storage, STORAGE_KEYS.rate, requested);
      applyRatePolicy('selected-rate-changed');
      pushDebug('player', 'info', 'PLAYBACK_RATE_CHANGED', { previous, selected: requested, effective: currentVideo.playbackRate });
      emitSnapshot();
      return true;
    } catch (error) {
      state.selectedRate = previous;
      try { currentVideo.playbackRate = previousEffective; } catch { /* No valid recovery available. */ }
      applyRatePolicy('rate-rejected');
      state.notice = `瀏覽器不支援 ${requested}x，已恢復 ${previous}x`;
      pushDebug('player', 'warn', 'PLAYBACK_RATE_REJECTED', { requested, previous, error });
      emitSnapshot();
      return false;
    }
  }

  function setLowLatency(enabled) {
    state.lowLatency = Boolean(enabled);
    writePreference(storage, STORAGE_KEYS.lowLatency, state.lowLatency);
    if (hls?.config) {
      Object.assign(hls.config, latencyProfile());
      try { hls.lowLatencyMode = state.lowLatency; } catch { /* Runtime switching is optional. */ }
    }
    if (state.mode === 'live' && state.lowLatency) goLive();
    else applyRatePolicy(state.lowLatency ? 'low-latency-enabled' : 'low-latency-disabled');
    pushDebug('player', 'info', 'LOW_LATENCY_CHANGED', { enabled: state.lowLatency, profile: latencyProfile() });
    emitSnapshot();
    return true;
  }

  async function share({ includeTime = false } = {}) {
    let url;
    try { url = new URL(locationImpl.href); } catch { url = new URL('http://localhost/'); }
    url.searchParams.delete('t');
    if (state.mode === 'record' && includeTime) url.searchParams.set('t', String(Math.floor(finiteOr(currentVideo.currentTime))));
    const data = { title: documentImpl?.title || 'ON LIVE', url: url.href };
    pushDebug('player', 'info', 'SHARE_ATTEMPT', { includeTime, url: data.url });
    if (navigatorImpl.share) {
      try {
        await navigatorImpl.share(data);
        state.shareStatus = '已開啟系統分享';
        pushDebug('player', 'info', 'SHARE_SUCCESS', { method: 'system' });
        emitSnapshot();
        return { ok: true, method: 'system', url: data.url };
      } catch (error) {
        if (error?.name === 'AbortError') {
          state.shareStatus = '';
          pushDebug('player', 'info', 'SHARE_CANCELLED', {});
          emitSnapshot();
          return { ok: false, cancelled: true, url: data.url };
        }
        state.shareStatus = '系統分享失敗，請稍後再試。';
        pushDebug('player', 'error', 'SHARE_FAILED', error);
        emitSnapshot();
        return { ok: false, error, url: data.url };
      }
    }
    try {
      if (!navigatorImpl.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await navigatorImpl.clipboard.writeText(data.url);
      state.shareStatus = '分享網址已複製';
      pushDebug('player', 'info', 'SHARE_SUCCESS', { method: 'clipboard' });
      emitSnapshot();
      return { ok: true, method: 'clipboard', url: data.url };
    } catch (error) {
      state.shareStatus = '無法複製分享網址，請手動複製網址列。';
      pushDebug('player', 'error', 'SHARE_FAILED', error);
      emitSnapshot();
      return { ok: false, error, url: data.url };
    }
  }

  async function togglePictureInPicture() {
    if (!documentImpl?.pictureInPictureEnabled || !currentVideo.requestPictureInPicture) return false;
    try {
      if (documentImpl.pictureInPictureElement === currentVideo) await documentImpl.exitPictureInPicture?.();
      else await currentVideo.requestPictureInPicture();
      return true;
    } catch (error) {
      state.lastError = { name: error?.name || 'PiPError', message: error?.message || String(error) };
      pushDebug('pip', 'error', 'PIP_ERROR', state.lastError);
      emitSnapshot();
      return false;
    }
  }

  async function toggleFullscreen() {
    if (!container.requestFullscreen || documentImpl?.fullscreenEnabled === false) return false;
    try {
      if (documentImpl.fullscreenElement === container) await documentImpl.exitFullscreen?.();
      else await container.requestFullscreen();
      return true;
    } catch (error) {
      state.lastError = { name: error?.name || 'FullscreenError', message: error?.message || String(error) };
      pushDebug('fullscreen', 'error', 'FULLSCREEN_ERROR', state.lastError);
      emitSnapshot();
      return false;
    }
  }

  function getDebugEntries(filters) {
    return debugLog.getEntries(filters);
  }

  function clearDebug() {
    debugLog.clear();
    emitSnapshot();
  }

  function exportDebug() {
    return debugLog.exportJson({ snapshot: lastSnapshot || buildSnapshot() });
  }

  function cleanup() {
    pushDebug('player', 'info', 'PLAYER_CLEANUP', { source: state.source });
    if (documentImpl?.pictureInPictureElement === currentVideo) Promise.resolve(documentImpl.exitPictureInPicture?.()).catch(() => {});
    clearSourceResources();
    state.mode = null;
    state.engine = 'none';
    state.source = '';
    state.sourceUrl = '';
    state.playerState = 'idle';
    state.autoplayState = 'idle';
    state.lastPlayResult = null;
    state.lastError = null;
    state.notice = '';
    state.userPaused = false;
    state.hasPlayed = false;
    setBoostCapability(false, '尚未載入可用來源');
    emitSnapshot();
  }

  async function destroy() {
    if (destroyed) return;
    pushDebug('player', 'info', 'PLAYER_DESTROY', {});
    cleanup();
    globalCleanups.forEach((remove) => remove());
    globalCleanups = [];
    await closeAudio();
    destroyed = true;
  }

  function handleVisibilityChange() {
    const visibility = documentImpl?.visibilityState;
    pushDebug('player', 'info', 'VISIBILITY_CHANGED', { visibility });
    if (visibility === 'hidden') {
      state.wasPlayingBeforeHidden = state.mode === 'live'
        && state.hasPlayed
        && !state.userPaused
        && !currentVideo.ended
        && !['offline', 'error', 'unsupported'].includes(state.playerState);
      emitSnapshot();
      return;
    }
    if (visibility !== 'visible' || !state.wasPlayingBeforeHidden || state.mode !== 'live' || state.userPaused || currentVideo.paused === false) {
      state.wasPlayingBeforeHidden = false;
      emitSnapshot();
      return;
    }
    state.wasPlayingBeforeHidden = false;
    const generation = sourceGeneration;
    requestVideoPlay().then(() => {
      if (generation !== sourceGeneration) return;
      state.lastPlayResult = { ok: true, reason: 'foreground-resume' };
      state.playerState = 'playing';
      pushDebug('autoplay', 'info', 'FOREGROUND_RESUME_SUCCESS', { muted: currentVideo.muted });
      emitSnapshot();
    }).catch(async (error) => {
      if (generation !== sourceGeneration) return;
      if (!currentVideo.muted && error?.name === 'NotAllowedError') {
        setVideoMuted(true, 'foreground-fallback');
        try {
          await requestVideoPlay();
          if (generation !== sourceGeneration) return;
          state.notice = '瀏覽器已靜音以繼續播放';
          state.playerState = 'playing';
          pushDebug('autoplay', 'warn', 'FOREGROUND_RESUME_MUTED', {});
        } catch (fallbackError) {
          state.lastError = serializePayload(fallbackError);
          pushDebug('autoplay', 'error', 'FOREGROUND_RESUME_FAILED', fallbackError);
        }
      } else {
        state.lastError = serializePayload(error);
        pushDebug('autoplay', 'error', 'FOREGROUND_RESUME_FAILED', error);
      }
      emitSnapshot();
    });
  }

  function handleFullscreenChange() {
    pushDebug('fullscreen', 'info', 'FULLSCREEN_CHANGED', { fullscreen: documentImpl?.fullscreenElement === container });
    emitSnapshot();
  }

  listen(documentImpl, 'visibilitychange', handleVisibilityChange, undefined, globalCleanups);
  listen(documentImpl, 'fullscreenchange', handleFullscreenChange, undefined, globalCleanups);
  currentVideo.muted = storedVolume === 0;
  applyVolume();
  let autoplayPolicy = 'unavailable';
  try { autoplayPolicy = navigatorImpl.getAutoplayPolicy?.(currentVideo) || 'unavailable'; } catch { /* Debug-only API. */ }
  pushDebug('player', 'info', 'PLAYER_CREATED', { autoplayPolicy });
  emitSnapshot();

  return Object.freeze({
    loadLive, loadRecord, retry, play, pause, seek, goLive, setMuted, setVolume, setBoost,
    setPlaybackRate, setLowLatency, share, togglePictureInPicture, toggleFullscreen,
    getDebugEntries, clearDebug, exportDebug, cleanup, destroy,
  });
}
