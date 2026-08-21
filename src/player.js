import { liveUrl, recordUrl } from './utils.js';

export function createPlayerController({ getVideo, getHls = () => globalThis.Hls, onState = () => {} }) {
  let hls = null;
  let cleanupListeners = [];
  let mediaRecoveryAttempted = false;

  function listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    cleanupListeners.push(() => target.removeEventListener(type, handler, options));
  }

  function cleanup() {
    cleanupListeners.forEach((remove) => remove());
    cleanupListeners = [];
    if (hls) {
      hls.destroy();
      hls = null;
    }
    const video = getVideo?.();
    if (video) {
      video.pause?.();
      video.removeAttribute?.('src');
      video.load?.();
    }
    mediaRecoveryAttempted = false;
  }

  function loadNative(url, kind) {
    const video = getVideo();
    listen(video, 'loadedmetadata', () => onState('ready'));
    listen(video, 'playing', () => onState('playing'));
    listen(video, 'error', () => onState(kind === 'live' ? 'offline' : 'error'));
    video.src = url;
    video.load?.();
  }

  function loadLive(streamer) {
    cleanup();
    const video = getVideo();
    const url = liveUrl(streamer);
    onState('loading');

    if (video.canPlayType?.('application/vnd.apple.mpegurl')) {
      loadNative(url, 'live');
      return 'native';
    }

    const Hls = getHls();
    if (!Hls?.isSupported?.()) {
      onState('unsupported');
      return 'unsupported';
    }

    hls = new Hls({ enableWorker: true, lowLatencyMode: true });
    hls.on(Hls.Events.MANIFEST_PARSED, () => onState('ready'));
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data?.fatal) return;
      if (data.type === Hls.ErrorTypes?.MEDIA_ERROR && !mediaRecoveryAttempted) {
        mediaRecoveryAttempted = true;
        hls?.recoverMediaError?.();
        return;
      }
      onState(data.type === Hls.ErrorTypes?.NETWORK_ERROR ? 'offline' : 'error');
      hls?.destroy();
      hls = null;
    });
    hls.loadSource(url);
    hls.attachMedia(video);
    listen(video, 'playing', () => onState('playing'));
    return 'hls';
  }

  function loadRecord(record) {
    cleanup();
    onState('loading');
    loadNative(recordUrl(record.filename), 'record');
    return 'native';
  }

  return { loadLive, loadRecord, cleanup };
}
