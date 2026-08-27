export const STORAGE_KEYS = Object.freeze({
  volume: 'onlive.player.volumePercent',
  boost: 'onlive.player.boostEnabled',
  rate: 'onlive.player.selectedRate',
  lowLatency: 'onlive.player.lowLatency',
});

export const MEDIA_EVENTS = Object.freeze([
  'loadedmetadata', 'playing', 'pause', 'waiting', 'stalled', 'canplay', 'progress', 'durationchange', 'ended', 'error',
  'ratechange', 'seeked', 'volumechange', 'enterpictureinpicture', 'leavepictureinpicture',
]);

export const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
export const finiteOr = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export function readPreference(storage, key, fallback) {
  try {
    const value = storage?.getItem?.(key);
    return value === null || value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

export function writePreference(storage, key, value) {
  try {
    storage?.setItem?.(key, String(value));
  } catch {
    // Storage is optional. Playback must continue when it is unavailable.
  }
}

export function readRanges(ranges) {
  const result = [];
  if (!ranges) return result;
  for (let index = 0; index < finiteOr(ranges.length); index += 1) {
    try {
      const start = Number(ranges.start(index));
      const end = Number(ranges.end(index));
      if (Number.isFinite(start) && Number.isFinite(end)) result.push({ start, end });
    } catch {
      break;
    }
  }
  return result;
}

export function latestRangeEnd(ranges) {
  return ranges.length ? ranges[ranges.length - 1].end : null;
}

export function forwardBufferFor(ranges, currentTime) {
  const range = ranges.find(({ start, end }) => currentTime >= start - 0.05 && currentTime <= end + 0.05);
  return range ? Math.max(0, range.end - currentTime) : 0;
}

export function defaultMessage(state) {
  if (state.notice) return state.notice;
  const statusMessage = {
    loading: '正在連線影音來源…',
    waiting: state.mode === 'live' ? '正在等待直播內容…' : '正在載入影片內容…',
    ready: '已就緒，按下播放即可開始。',
    ended: '直播已結束。',
    offline: '目前沒有直播，或串流無法取得。',
    unsupported: '這個瀏覽器不支援此影音格式。',
    error: state.mode === 'record' ? '瀏覽器無法播放這份直播紀錄。' : '影音播放發生錯誤。',
  }[state.playerState];
  if (['loading', 'waiting', 'ended', 'offline', 'unsupported', 'error'].includes(state.playerState)) return statusMessage;
  if (state.autoplayState === 'blocked') return '瀏覽器已阻擋自動播放，請按下播放。';
  if (state.autoplayState === 'playing-muted') return '直播已靜音／開啟聲音';
  return statusMessage || '';
}
