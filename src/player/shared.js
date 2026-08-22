export const STORAGE_KEYS = Object.freeze({
  volume: 'oktw.player.volumePercent',
  boost: 'oktw.player.boostEnabled',
  rate: 'oktw.player.selectedRate',
  autoCatchUp: 'oktw.player.autoCatchUp',
});

export const MEDIA_EVENTS = Object.freeze([
  'abort', 'canplay', 'canplaythrough', 'durationchange', 'emptied', 'encrypted', 'ended', 'error',
  'loadeddata', 'loadedmetadata', 'loadstart', 'pause', 'play', 'playing', 'progress', 'ratechange',
  'seeked', 'seeking', 'stalled', 'suspend', 'timeupdate', 'volumechange', 'waiting', 'waitingforkey',
  'enterpictureinpicture', 'leavepictureinpicture',
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

export function freezeSnapshot(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freezeSnapshot);
  return Object.freeze(value);
}

export function defaultMessage(state) {
  if (state.notice) return state.notice;
  if (state.autoplayState === 'blocked') return '瀏覽器已阻擋自動播放，請按下播放。';
  if (state.autoplayState === 'playing-muted') return '直播已靜音／開啟聲音';
  return {
    loading: '正在連線影音來源…',
    ready: '已就緒，按下播放即可開始。',
    offline: '目前沒有直播，或串流無法取得。',
    unsupported: '這個瀏覽器不支援此影音格式。',
    error: state.mode === 'record' ? '瀏覽器無法播放這份直播紀錄。' : '影音播放發生錯誤。',
  }[state.playerState] || '';
}
