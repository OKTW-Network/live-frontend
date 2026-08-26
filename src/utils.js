export const RECORD_LIST_URL = '/record/list.json';
export const PAGE_SIZE = 24;

const filenamePattern = /^(.*)-(\d+)\.([^.]+)$/;

export function parseRecordEntry(entry) {
  const format = entry?.format;
  if (!format || typeof format.filename !== 'string') return null;

  const match = format.filename.match(filenamePattern);
  if (!match || !match[1]) return null;

  const timestamp = Number(match[2]);
  const size = Number(format.size);
  const duration = Number(format.duration);
  if (![timestamp, size, duration].every(Number.isFinite)) return null;
  if (timestamp <= 0 || size < 0 || duration < 0) return null;

  return {
    filename: format.filename,
    streamer: match[1],
    timestamp,
    extension: match[3].toLowerCase(),
    size,
    duration,
  };
}

export function normalizeRecords(payload) {
  if (!Array.isArray(payload)) return [];
  return payload
    .map(parseRecordEntry)
    .filter(Boolean)
    .sort((a, b) => b.timestamp - a.timestamp || a.filename.localeCompare(b.filename));
}

export function deriveStreamers(records) {
  const streamers = new Map();
  for (const record of records) {
    const current = streamers.get(record.streamer);
    if (current) {
      current.recordCount += 1;
      current.latestTimestamp = Math.max(current.latestTimestamp, record.timestamp);
    } else {
      streamers.set(record.streamer, {
        name: record.streamer,
        recordCount: 1,
        latestTimestamp: record.timestamp,
        previewFilename: record.filename,
      });
    }
  }
  return [...streamers.values()].sort(
    (a, b) => b.latestTimestamp - a.latestTimestamp || a.name.localeCompare(b.name),
  );
}

export function orderStreamersByStatus(streamers, statuses = {}) {
  return [...streamers].sort((a, b) => {
    const liveDifference = Number(statuses[b.name] === 'online') - Number(statuses[a.name] === 'online');
    return liveDifference || b.latestTimestamp - a.latestTimestamp || a.name.localeCompare(b.name);
  });
}

const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;

export function normalizeDateFilter(value) {
  const match = String(value || '').match(datePattern);
  if (!match) return '';
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() !== Number(month) - 1
    || date.getUTCDate() !== Number(day)
  ) return '';
  return `${year}-${month}-${day}`;
}

function taipeiDayBoundary(value, nextDay = false) {
  const normalized = normalizeDateFilter(value);
  if (!normalized) return null;
  const [year, month, day] = normalized.split('-').map(Number);
  return (Date.UTC(year, month - 1, day + Number(nextDay)) / 1000) - (8 * 60 * 60);
}

export function isDateRangeInverted({ from = '', to = '' } = {}) {
  const fromValue = normalizeDateFilter(from);
  const toValue = normalizeDateFilter(to);
  return Boolean(fromValue && toValue && fromValue > toValue);
}

export function filterRecords(records, {
  query = '', streamer = '', from = '', to = '', sort = 'newest',
} = {}) {
  if (isDateRangeInverted({ from, to })) return [];
  const needle = query.trim().toLocaleLowerCase('zh-TW');
  const fromTimestamp = taipeiDayBoundary(from);
  const toTimestamp = taipeiDayBoundary(to, true);
  const filtered = records.filter((record) => {
    if (streamer && record.streamer !== streamer) return false;
    if (fromTimestamp !== null && record.timestamp < fromTimestamp) return false;
    if (toTimestamp !== null && record.timestamp >= toTimestamp) return false;
    if (!needle) return true;
    return `${record.streamer} ${record.filename}`.toLocaleLowerCase('zh-TW').includes(needle);
  });
  if (sort === 'oldest') return [...filtered].sort((a, b) => a.timestamp - b.timestamp);
  return filtered;
}

export function parseRecordQuery(value = '') {
  const params = value instanceof URLSearchParams
    ? value
    : new URLSearchParams(String(value).replace(/^\?/, ''));
  return {
    query: params.get('q') || '',
    streamer: params.get('streamer') || '',
    from: normalizeDateFilter(params.get('from')),
    to: normalizeDateFilter(params.get('to')),
    sort: params.get('sort') === 'oldest' ? 'oldest' : 'newest',
  };
}

export function serializeRecordQuery(filters = {}) {
  const normalized = parseRecordQuery(new URLSearchParams([
    ['q', filters.query || ''],
    ['streamer', filters.streamer || ''],
    ['from', filters.from || ''],
    ['to', filters.to || ''],
    ['sort', filters.sort || ''],
  ]));
  const params = new URLSearchParams();
  if (normalized.query) params.set('q', normalized.query);
  if (normalized.streamer) params.set('streamer', normalized.streamer);
  if (normalized.from) params.set('from', normalized.from);
  if (normalized.to) params.set('to', normalized.to);
  if (normalized.sort === 'oldest') params.set('sort', 'oldest');
  return params.size ? `?${params.toString()}` : '';
}

const fullDateFormatter = new Intl.DateTimeFormat('zh-TW-u-ca-gregory', {
  timeZone: 'Asia/Taipei',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function formatDate(timestamp) {
  const value = Number(timestamp);
  return Number.isFinite(value) ? fullDateFormatter.format(new Date(value * 1000)) : '—';
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainingSeconds = total % 60;
  return [hours, minutes, remainingSeconds].map((value) => String(value).padStart(2, '0')).join(':');
}

export function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 2 }).format(size)} ${units[unitIndex]}`;
}

export function decodePathSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function streamerPath(streamer) {
  return `/@${encodeURIComponent(streamer)}`;
}

export function recordPath(filename) {
  return `/watch/${encodeURIComponent(filename)}`;
}

export function parseRoute(pathname = '/') {
  if (pathname === '/') return { view: 'home' };
  if (pathname === '/records') return { view: 'records' };

  const channelMatch = pathname.match(/^\/@([^/]+)$/);
  if (channelMatch) {
    const streamer = decodePathSegment(channelMatch[1]);
    if (streamer) return { view: 'channel', streamer };
  }

  const recordMatch = pathname.match(/^\/watch\/([^/]+)$/);
  if (recordMatch) {
    const filename = decodePathSegment(recordMatch[1]);
    if (filename) return { view: 'record', filename };
  }

  return { view: 'notFound' };
}

export function liveUrl(streamer) {
  return `/live/${encodeURIComponent(streamer)}.m3u8`;
}

export function liveThumbnailUrl(streamer, version = '') {
  const url = `/live/${encodeURIComponent(streamer)}.png`;
  return version === '' ? url : `${url}?v=${encodeURIComponent(version)}`;
}

export function recordUrl(filename) {
  const playable = String(filename).replace(/\.flv$/i, '.mp4');
  return `/record/${encodeURIComponent(playable)}`;
}

export function thumbnailUrl(filename, extension = 'jxl') {
  const basename = String(filename).replace(/\.[^.]+$/, '');
  return `/record/${encodeURIComponent(basename)}.${extension}`;
}

export function nextThumbnailExtension(extension) {
  return { jxl: 'avif', avif: 'png', png: null }[extension] ?? null;
}

export async function probeLive(streamer, { timeoutMs = 5000 } = {}) {
  try {
    const response = await fetch(liveUrl(streamer), {
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    return (await response.text()).trimStart().startsWith('#EXTM3U');
  } catch {
    return false;
  }
}

export function metadataForPath(pathname) {
  const defaultDescription = '瀏覽主播、觀看正在進行的直播與直播紀錄，並在即時聊天室一起參與。';
  const route = parseRoute(pathname);
  if (route.view === 'home') {
    return { title: 'ON LIVE — 直播、主播與直播紀錄', description: defaultDescription };
  }
  if (route.view === 'records') {
    return { title: '直播紀錄 — ON LIVE', description: '搜尋、篩選並播放 ON LIVE 的所有直播紀錄。' };
  }
  if (route.view === 'channel') {
    return { title: `${route.streamer} — ON LIVE`, description: `觀看 ${route.streamer} 的即時直播與過去直播紀錄。` };
  }
  if (route.view === 'record') {
    const match = route.filename.match(filenamePattern);
    if (match) return { title: `${match[1]} 直播紀錄 — ON LIVE`, description: `播放 ${route.filename} 直播紀錄。` };
  }
  return { title: '找不到頁面 — ON LIVE', description: defaultDescription };
}
