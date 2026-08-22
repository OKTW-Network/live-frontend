import { clamp, finiteOr } from './shared.js';

export function createAudioSession({
  getVideo,
  setCurrentVideo,
  state,
  AudioContextImpl,
  pushDebug,
  emitSnapshot,
  listen,
  onVideoChange = () => {},
  getSourceCleanups,
  setSourceCleanups,
  globalCleanups,
  getPreferredVolume,
  locationImpl,
  fetchImpl,
  onVideoReplaced = () => {},
} = {}) {
  let audioContext = null;
  let audioSource = null;
  let gainNode = null;
  let audioSourceVideo = null;
  let nativeCorsFallbackAttempted = false;

  function effectiveVolume() {
    return clamp(getPreferredVolume(), 0, state.boostEnabled && state.boostAvailable ? 200 : 100);
  }

  function applyVolume() {
    const video = getVideo();
    const volume = effectiveVolume();
    if (gainNode?.gain) gainNode.gain.value = volume / 100;
    video.volume = audioSourceVideo === video && gainNode ? 1 : clamp(volume / 100, 0, 1);
  }

  function setBoostCapability(allowed, reason = '') {
    state.webAudioAllowed = Boolean(allowed);
    state.boostAvailable = Boolean(allowed && AudioContextImpl);
    state.boostUnavailableReason = state.boostAvailable
      ? ''
      : reason || (AudioContextImpl ? '來源未開放 Web Audio' : '瀏覽器不支援 Web Audio');
    applyVolume();
  }

  function disconnect() {
    try { audioSource?.disconnect?.(); } catch {}
    try { gainNode?.disconnect?.(); } catch {}
    audioSource = null;
    gainNode = null;
    audioSourceVideo = null;
  }

  function replaceVideoForNativeAudio() {
    const currentVideo = getVideo();
    if (!audioSource || audioSourceVideo !== currentVideo || !currentVideo.cloneNode) return false;
    const replacement = currentVideo.cloneNode(true);
    replacement.removeAttribute?.('src');
    replacement.removeAttribute?.('crossorigin');
    replacement.src = '';
    replacement.muted = state.muted;
    const parent = currentVideo.parentNode;
    if (!parent?.replaceChild) return false;
    getSourceCleanups().forEach((remove) => remove());
    setSourceCleanups([]);
    const previous = currentVideo;
    disconnect();
    parent.replaceChild(replacement, previous);
    setCurrentVideo(replacement);
    pushDebug('audio', 'warn', 'MEDIA_ELEMENT_REPLACED', { reason: 'cors-native-fallback' });
    try { onVideoChange(replacement); } catch {}
    return true;
  }

  function ensureGraph() {
    if (!state.webAudioAllowed || !AudioContextImpl) return null;
    const currentVideo = getVideo();
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
        disconnect();
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

  async function configureNativeSource(url, generation, sourceGeneration) {
    const cors = await probeCors(url);
    if (generation !== sourceGeneration) return false;
    const currentVideo = getVideo();
    const replaced = !cors.allowed && audioSourceVideo === currentVideo && replaceVideoForNativeAudio();
    if (replaced) onVideoReplaced();
    const video = getVideo();
    if (cors.crossOrigin) {
      video.crossOrigin = 'anonymous';
      video.setAttribute?.('crossorigin', 'anonymous');
    } else {
      video.removeAttribute?.('crossorigin');
      try { video.crossOrigin = null; } catch {}
    }
    setBoostCapability(cors.allowed, cors.allowed ? '' : '跨來源影音未開放 CORS，僅支援 0–100%');
    return true;
  }

  function handleNativeCorsFailure() {
    const currentVideo = getVideo();
    if (state.engine !== 'native' || !currentVideo.crossOrigin || nativeCorsFallbackAttempted) return false;
    nativeCorsFallbackAttempted = true;
    const url = state.sourceUrl;
    pushDebug('audio', 'warn', 'CORS_MEDIA_FALLBACK', { url });
    const replaced = audioSourceVideo === currentVideo && replaceVideoForNativeAudio();
    const video = getVideo();
    video.removeAttribute?.('crossorigin');
    try { video.crossOrigin = null; } catch {}
    setBoostCapability(false, '跨來源影音未開放 CORS，已使用原生音量');
    if (replaced) onVideoReplaced();
    video.src = url;
    video.load?.();
    return true;
  }

  async function close() {
    disconnect();
    if (audioContext && audioContext.state !== 'closed') {
      try { await audioContext.close?.(); } catch { /* Best-effort close. */ }
    }
  }

  function resetCorsFallback() {
    nativeCorsFallbackAttempted = false;
  }

  return {
    disconnect,
    ensureGraph,
    startActivation,
    setBoostCapability,
    applyVolume,
    effectiveVolume,
    probeCors,
    configureNativeSource,
    replaceVideoForNativeAudio,
    handleNativeCorsFailure,
    close,
    resetCorsFallback,
    getGainNode: () => gainNode,
    getAudioContext: () => audioContext,
    getAudioSourceVideo: () => audioSourceVideo,
  };
}
