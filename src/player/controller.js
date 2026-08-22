import { liveUrl, recordUrl } from '../utils.js';
import { createAudioSession } from './audio.js';
import { createCatchUp } from './catch-up.js';
import { createDebugLog, serializePayload } from './debug.js';
import {
  MEDIA_EVENTS,
  STORAGE_KEYS,
  clamp,
  defaultMessage,
  finiteOr,
  freezeSnapshot,
  latestRangeEnd,
  readPreference,
  readRanges,
  writePreference,
} from './shared.js';

export const PLAYER_RATES = Object.freeze([0.25, 0.5, 0.75, 1, 2, 4, 8, 16]);

export function createPlayerController({
  video,
  container,
  getHls = () => globalThis.Hls,
  storage = globalThis.localStorage,
  environment = {},
  onSnapshot = () => {},
  onDebug = () => {},
  onVideoChange = () => {},
} = {}) {
  if (!video) throw new TypeError('createPlayerController requires a video element');
  if (!container) throw new TypeError('createPlayerController requires a player container');

  const documentImpl = environment.document ?? globalThis.document;
  const navigatorImpl = environment.navigator ?? globalThis.navigator ?? {};
  const locationImpl = environment.location ?? globalThis.location ?? { href: 'http://localhost/' };
  const fetchImpl = environment.fetch ?? globalThis.fetch;
  const AudioContextImpl = environment.AudioContext ?? globalThis.AudioContext ?? globalThis.webkitAudioContext;
  const now = environment.now ?? Date.now;
  const setIntervalImpl = environment.setInterval ?? globalThis.setInterval;
  const clearIntervalImpl = environment.clearInterval ?? globalThis.clearInterval;

  const storedVolume = clamp(finiteOr(readPreference(storage, STORAGE_KEYS.volume, 100), 100), 0, 200);
  const storedRate = Number(readPreference(storage, STORAGE_KEYS.rate, 1));
  let preferredVolume = storedVolume;
  let lastAudibleVolume = storedVolume > 0 ? storedVolume : 100;
  let hls = null;
  let currentVideo = video;
  let sourceDescriptor = null;
  let sourceGeneration = 0;
  let sourceCleanups = [];
  let globalCleanups = [];
  let pendingTimecode = null;
  let autoplayAttempted = false;
  let mediaRecoveryAttempted = false;
  let suppressPauseEvent = false;
  let lastSnapshot = null;
  let destroyed = false;

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
    muted: storedVolume === 0,
    muteReason: storedVolume === 0 ? 'volume-zero' : 'none',
    boostEnabled: readPreference(storage, STORAGE_KEYS.boost, 'false') === 'true',
    boostAvailable: false,
    boostUnavailableReason: AudioContextImpl ? '尚未載入可用來源' : '瀏覽器不支援 Web Audio',
    webAudioAllowed: false,
    selectedRate: PLAYER_RATES.includes(storedRate) ? storedRate : 1,
    autoCatchUp: readPreference(storage, STORAGE_KEYS.autoCatchUp, 'true') !== 'false',
    following: false,
    waiting: false,
    targetLatency: null,
    latency: null,
    forwardBuffer: 0,
    catchUpActive: false,
    catchUpReason: 'idle',
    userPaused: false,
    wasPlayingBeforeHidden: false,
    hasPlayed: false,
    pip: false,
    fullscreen: false,
    shareStatus: '',
  };

  const debugLog = createDebugLog({ now, onDebug });
  const pushDebug = (...args) => debugLog.push(...args);

  function listen(target, type, handler, options, collection = sourceCleanups) {
    if (!target?.addEventListener) return;
    target.addEventListener(type, handler, options);
    collection.push(() => target.removeEventListener?.(type, handler, options));
  }

  const audio = createAudioSession({
    getVideo: () => currentVideo,
    setCurrentVideo: (next) => { currentVideo = next; },
    state,
    AudioContextImpl,
    pushDebug,
    emitSnapshot: () => emitSnapshot(),
    listen,
    onVideoChange,
    getSourceCleanups: () => sourceCleanups,
    setSourceCleanups: (next) => { sourceCleanups = next; },
    globalCleanups,
    getPreferredVolume: () => preferredVolume,
    locationImpl,
    fetchImpl,
    onVideoReplaced: () => bindMediaEvents(),
  });

  const catchUp = createCatchUp({
    state,
    getVideo: () => currentVideo,
    getHls: () => hls,
    pushDebug,
    emitSnapshot: () => emitSnapshot(),
    setIntervalImpl,
    clearIntervalImpl,
  });

  function buildSnapshot() {
    catchUp.updateLiveMetrics();
    const buffered = readRanges(currentVideo.buffered);
    const seekable = readRanges(currentVideo.seekable);
    const timelineStart = seekable.length ? seekable[0].start : 0;
    const duration = Number(currentVideo.duration);
    const timelineEnd = seekable.length
      ? seekable[seekable.length - 1].end
      : Number.isFinite(duration) ? Math.max(0, duration) : 0;
    const volume = audio.effectiveVolume();
    const gainNode = audio.getGainNode();
    const audioContext = audio.getAudioContext();
    const snapshot = {
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
      canSeek: timelineEnd > timelineStart,
      selectedRate: state.selectedRate,
      effectiveRate: finiteOr(currentVideo.playbackRate, 1),
      autoCatchUp: state.autoCatchUp,
      following: state.following,
      catchUpActive: state.catchUpActive,
      catchUpReason: state.catchUpReason,
      latency: state.latency,
      targetLatency: state.targetLatency,
      forwardBuffer: state.forwardBuffer,
      volumePercent: volume,
      preferredVolumePercent: preferredVolume,
      muted: Boolean(currentVideo.muted || state.muted),
      muteReason: state.muteReason,
      boostEnabled: state.boostEnabled,
      boostAvailable: state.boostAvailable,
      boostUnavailableReason: state.boostUnavailableReason,
      gain: gainNode?.gain ? finiteOr(gainNode.gain.value, volume / 100) : volume / 100,
      audioContextState: audioContext?.state || (AudioContextImpl ? 'not-created' : 'unavailable'),
      autoplayState: state.autoplayState,
      lastPlayResult: state.lastPlayResult,
      pip: state.pip,
      fullscreen: state.fullscreen,
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
    return freezeSnapshot(snapshot);
  }

  function emitSnapshot() {
    if (destroyed) return lastSnapshot;
    lastSnapshot = buildSnapshot();
    try { onSnapshot(lastSnapshot); } catch { /* Rendering callbacks must not break playback. */ }
    return lastSnapshot;
  }

  function setVideoMuted(muted, reason) {
    state.muted = Boolean(muted);
    state.muteReason = muted ? reason : 'none';
    currentVideo.muted = Boolean(muted);
    pushDebug('player', 'info', 'MUTE_CHANGED', { muted: state.muted, reason: state.muteReason });
  }

  function requestVideoPlay() {
    try { return Promise.resolve(currentVideo.play?.()); } catch (error) { return Promise.reject(error); }
  }

  async function userActivatedPlay({ unmute = false, reason = 'manual-play' } = {}) {
    state.notice = '';
    const generation = sourceGeneration;
    const audioPromise = audio.startActivation();
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
      catchUp.applyRatePolicy('manual-play');
      emitSnapshot();
      return true;
    }

    const error = playResult.reason;
    state.lastPlayResult = { ok: false, name: error?.name || 'Error', message: error?.message || String(error), reason };
    state.lastError = state.lastPlayResult;
    state.playerState = error?.name === 'NotAllowedError' ? 'ready' : 'error';
    pushDebug('player', 'error', 'PLAY_FAILED', state.lastPlayResult);
    emitSnapshot();
    return false;
  }

  async function attemptMutedAutoplay() {
    if (autoplayAttempted || state.mode !== 'live') return false;
    autoplayAttempted = true;
    const generation = sourceGeneration;
    setVideoMuted(true, 'autoplay');
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
        state.playerState = state.mode === 'live' ? 'offline' : 'error';
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
      else if (state.engine === 'native') attemptMutedAutoplay();
    } else if (type === 'playing') {
      state.playerState = 'playing';
      state.waiting = false;
      state.userPaused = false;
      state.hasPlayed = true;
      catchUp.applyRatePolicy('playing');
    } else if (type === 'pause') {
      if (!suppressPauseEvent && state.pip && state.playerState !== 'idle') state.userPaused = true;
      if (state.playerState !== 'idle' && !currentVideo.ended) state.playerState = 'paused';
      catchUp.applyRatePolicy('paused');
    } else if (type === 'waiting' || type === 'stalled') {
      state.waiting = true;
      state.playerState = 'waiting';
      catchUp.stopCatchUp(type);
    } else if (type === 'canplay') {
      state.waiting = false;
      if (currentVideo.paused && state.playerState === 'waiting') state.playerState = 'ready';
    } else if (type === 'ended') {
      state.playerState = 'paused';
      state.userPaused = false;
      catchUp.stopCatchUp('ended');
    } else if (type === 'error') {
      if (audio.handleNativeCorsFailure()) return;
      state.lastError = serializePayload(currentVideo.error || { message: 'Media element error' });
      state.playerState = state.mode === 'live' ? 'offline' : 'error';
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
      catchUp.updateFollowingAfterSeek();
    } else if (type === 'volumechange') {
      state.muted = Boolean(currentVideo.muted);
      if (!audio.getGainNode() && Number.isFinite(currentVideo.volume)) preferredVolume = Math.round(currentVideo.volume * 100);
    } else if (type === 'enterpictureinpicture') {
      state.pip = true;
      pushDebug('pip', 'info', 'PIP_ENTER', {});
    } else if (type === 'leavepictureinpicture') {
      state.pip = false;
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
    catchUp.reset();
    if (hls) {
      try { hls.destroy?.(); } catch { /* Best-effort teardown. */ }
      hls = null;
    }
    autoplayAttempted = false;
    mediaRecoveryAttempted = false;
    audio.resetCorsFallback();
    pendingTimecode = null;
    state.following = false;
    state.waiting = false;
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
    sourceDescriptor = { mode, source, url };
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
    state.pip = false;
    state.following = mode === 'live';
    audio.setBoostCapability(false, '正在確認來源的 Web Audio 能力');
    currentVideo.playsInline = true;
    currentVideo.setAttribute?.('playsinline', '');
    if (mode === 'live' && !preserveMute) {
      currentVideo.defaultMuted = true;
      currentVideo.setAttribute?.('muted', '');
      setVideoMuted(true, 'new-live');
    } else currentVideo.muted = state.muted;
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
    [...new Set(Object.values(Hls.Events || {}))].forEach((eventName) => {
      hls.on(eventName, (_event, data) => {
        if (generation !== sourceGeneration) return;
        pushDebug('hls', data?.fatal ? 'error' : 'debug', eventName, data);
        if (eventName === Hls.Events.MANIFEST_PARSED) {
          state.playerState = 'ready';
          audio.setBoostCapability(true);
          attemptMutedAutoplay();
        }
        if (eventName === Hls.Events.ERROR && data?.fatal) {
          if (data.type === Hls.ErrorTypes?.MEDIA_ERROR && !mediaRecoveryAttempted) {
            mediaRecoveryAttempted = true;
            pushDebug('hls', 'warn', 'HLS_MEDIA_RECOVERY', data);
            hls?.recoverMediaError?.();
          } else {
            state.lastError = serializePayload(data);
            state.playerState = data.type === Hls.ErrorTypes?.NETWORK_ERROR ? 'offline' : 'error';
            hls?.destroy?.();
            hls = null;
            emitSnapshot();
          }
        }
      });
    });
  }

  async function loadLive(streamer, options = {}) {
    const url = liveUrl(streamer);
    const generation = initializeSource('live', streamer, url, { preserveMute: Boolean(options.preserveMute) });
    if (currentVideo.canPlayType?.('application/vnd.apple.mpegurl')) {
      const configured = await audio.configureNativeSource(url, generation, sourceGeneration);
      if (!configured || generation !== sourceGeneration) return 'cancelled';
      state.engine = 'native';
      currentVideo.src = url;
      currentVideo.load?.();
      catchUp.startLiveTimer();
      pushDebug('player', 'info', 'ENGINE_SELECTED', { engine: 'native' });
      emitSnapshot();
      return 'native';
    }

    const Hls = getHls?.();
    if (!Hls?.isSupported?.()) {
      state.playerState = 'unsupported';
      state.engine = 'unsupported';
      pushDebug('player', 'error', 'ENGINE_UNSUPPORTED', { mode: 'live' });
      emitSnapshot();
      return 'unsupported';
    }
    state.engine = 'hls';
    audio.setBoostCapability(true);
    hls = new Hls({ enableWorker: true, lowLatencyMode: true, maxLiveSyncPlaybackRate: 1.25 });
    bindHlsEvents(Hls, generation);
    hls.attachMedia(currentVideo);
    hls.loadSource(url);
    catchUp.startLiveTimer();
    pushDebug('player', 'info', 'ENGINE_SELECTED', { engine: 'hls' });
    emitSnapshot();
    return 'hls';
  }

  async function loadRecord(record, { timecode = null } = {}) {
    const url = recordUrl(record.filename);
    const generation = initializeSource('record', record.filename, url, { preserveMute: true });
    pendingTimecode = parseTimecode(timecode);
    const configured = await audio.configureNativeSource(url, generation, sourceGeneration);
    if (!configured || generation !== sourceGeneration) return 'cancelled';
    state.engine = 'native';
    currentVideo.src = url;
    currentVideo.load?.();
    pushDebug('player', 'info', 'ENGINE_SELECTED', { engine: 'native', record: record.filename });
    emitSnapshot();
    return 'native';
  }

  async function retry() {
    if (!sourceDescriptor) return 'idle';
    const descriptor = { ...sourceDescriptor };
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
    catchUp.applyRatePolicy('user-paused');
    emitSnapshot();
  }

  function seek(seconds) {
    if (!Number.isFinite(Number(seconds))) return false;
    const seekable = readRanges(currentVideo.seekable);
    const duration = Number(currentVideo.duration);
    let target = Number(seconds);
    if (state.mode === 'live' && seekable.length) target = clamp(target, seekable[0].start, seekable[seekable.length - 1].end);
    else if (Number.isFinite(duration)) target = clamp(target, 0, duration);
    try { currentVideo.currentTime = target; } catch (error) {
      pushDebug('player', 'error', 'SEEK_FAILED', { target, error });
      return false;
    }
    pushDebug('player', 'info', 'USER_SEEK', { target });
    catchUp.updateFollowingAfterSeek();
    emitSnapshot();
    return true;
  }

  function goLive() {
    const end = latestRangeEnd(readRanges(currentVideo.buffered));
    if (end === null) return false;
    const target = Math.max(0, end - 0.25);
    const result = seek(target);
    if (result) {
      state.following = true;
      state.catchUpReason = 'go-live';
      pushDebug('player', 'info', 'GO_LIVE', { target, bufferedEnd: end });
      catchUp.applyRatePolicy('go-live');
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
      audio.applyVolume();
    }
    return userActivatedPlay({ unmute: true, reason: 'user-unmute' });
  }

  function setVolume(percent) {
    const maximum = state.boostEnabled && state.boostAvailable ? 200 : 100;
    preferredVolume = clamp(finiteOr(percent), 0, maximum);
    if (preferredVolume > 0) lastAudibleVolume = preferredVolume;
    writePreference(storage, STORAGE_KEYS.volume, preferredVolume);
    audio.applyVolume();
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
    audio.applyVolume();
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
      catchUp.applyRatePolicy('selected-rate-changed');
      pushDebug('player', 'info', 'PLAYBACK_RATE_CHANGED', { previous, selected: requested, effective: currentVideo.playbackRate });
      emitSnapshot();
      return true;
    } catch (error) {
      state.selectedRate = previous;
      try { currentVideo.playbackRate = previousEffective; } catch { /* No valid recovery available. */ }
      catchUp.applyRatePolicy('rate-rejected');
      state.notice = `瀏覽器不支援 ${requested}x，已恢復 ${previous}x`;
      pushDebug('player', 'warn', 'PLAYBACK_RATE_REJECTED', { requested, previous, error });
      emitSnapshot();
      return false;
    }
  }

  function setAutoCatchUp(enabled) {
    state.autoCatchUp = Boolean(enabled);
    writePreference(storage, STORAGE_KEYS.autoCatchUp, state.autoCatchUp);
    catchUp.applyRatePolicy(state.autoCatchUp ? 'auto-catch-up-enabled' : 'auto-catch-up-disabled');
    pushDebug('player', 'info', 'AUTO_CATCH_UP_CHANGED', { enabled: state.autoCatchUp });
    emitSnapshot();
  }

  async function share({ includeTime = false } = {}) {
    let url;
    try { url = new URL(locationImpl.href); } catch { url = new URL('http://localhost/'); }
    url.searchParams.delete('t');
    if (state.mode === 'record' && includeTime) url.searchParams.set('t', String(Math.floor(finiteOr(currentVideo.currentTime))));
    const data = { title: documentImpl?.title || 'OKTW Live', url: url.href };
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
    sourceDescriptor = null;
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
    state.pip = false;
    audio.setBoostCapability(false, '尚未載入可用來源');
    emitSnapshot();
  }

  async function destroy() {
    if (destroyed) return;
    pushDebug('player', 'info', 'PLAYER_DESTROY', {});
    cleanup();
    globalCleanups.forEach((remove) => remove());
    globalCleanups = [];
    await audio.close();
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
    state.fullscreen = documentImpl?.fullscreenElement === container;
    pushDebug('fullscreen', 'info', 'FULLSCREEN_CHANGED', { fullscreen: state.fullscreen });
    emitSnapshot();
  }

  listen(documentImpl, 'visibilitychange', handleVisibilityChange, undefined, globalCleanups);
  listen(documentImpl, 'fullscreenchange', handleFullscreenChange, undefined, globalCleanups);
  currentVideo.muted = state.muted;
  audio.applyVolume();
  let autoplayPolicy = 'unavailable';
  try { autoplayPolicy = navigatorImpl.getAutoplayPolicy?.(currentVideo) || 'unavailable'; } catch { /* Debug-only API. */ }
  pushDebug('player', 'info', 'PLAYER_CREATED', { autoplayPolicy });
  emitSnapshot();

  return Object.freeze({
    loadLive, loadRecord, retry, play, pause, seek, goLive, setMuted, setVolume, setBoost,
    setPlaybackRate, setAutoCatchUp, share, togglePictureInPicture, toggleFullscreen,
    getDebugEntries, clearDebug, exportDebug, cleanup, destroy,
  });
}
