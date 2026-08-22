const useDevelopmentProxy = import.meta.env?.DEV === true;

export const API_BASE = useDevelopmentProxy ? '/__upstream' : 'https://live.oktw.one';
export const RECORD_LIST_URL = `${API_BASE}/record/list.json`;
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

export function selectLiveStreamers(streamers, statuses = {}) {
  return streamers.filter((streamer) => statuses[streamer.name] === 'online');
}

export function orderStreamersByStatus(streamers, statuses = {}) {
  return [...streamers].sort((a, b) => {
    const liveDifference = Number(statuses[b.name] === 'online') - Number(statuses[a.name] === 'online');
    return liveDifference || b.latestTimestamp - a.latestTimestamp || a.name.localeCompare(b.name);
  });
}

export function filterRecords(records, { query = '', streamer = '', sort = 'newest' } = {}) {
  const needle = query.trim().toLocaleLowerCase('zh-TW');
  const filtered = records.filter((record) => {
    if (streamer && record.streamer !== streamer) return false;
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
    sort: params.get('sort') === 'oldest' ? 'oldest' : 'newest',
  };
}

export function serializeRecordQuery(filters = {}) {
  const normalized = parseRecordQuery(new URLSearchParams([
    ['q', filters.query || ''],
    ['streamer', filters.streamer || ''],
    ['sort', filters.sort || ''],
  ]));
  const params = new URLSearchParams();
  if (normalized.query) params.set('q', normalized.query);
  if (normalized.streamer) params.set('streamer', normalized.streamer);
  if (normalized.sort === 'oldest') params.set('sort', 'oldest');
  return params.size ? `?${params.toString()}` : '';
}

export function createRecordViewSnapshot({ filters = {}, visibleCount = PAGE_SIZE, scrollY = 0 } = {}) {
  return {
    filters: parseRecordQuery(serializeRecordQuery(filters)),
    visibleCount: Math.max(PAGE_SIZE, Math.floor(Number(visibleCount) || PAGE_SIZE)),
    scrollY: Math.max(0, Number(scrollY) || 0),
  };
}

export function recordViewSnapshotMatches(snapshot, filters) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  return serializeRecordQuery(snapshot.filters) === serializeRecordQuery(filters);
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

const shortDateFormatter = new Intl.DateTimeFormat('zh-TW-u-ca-gregory', {
  timeZone: 'Asia/Taipei',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

export function formatDate(timestamp) {
  const value = Number(timestamp);
  return Number.isFinite(value) ? fullDateFormatter.format(new Date(value * 1000)) : '—';
}

export function formatShortDate(timestamp) {
  const value = Number(timestamp);
  return Number.isFinite(value) ? shortDateFormatter.format(new Date(value * 1000)) : '—';
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

export function encodePathSegment(value) {
  return encodeURIComponent(value);
}

export function decodePathSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function streamerPath(streamer) {
  return `/@${encodePathSegment(streamer)}`;
}

export function recordPath(filename) {
  return `/record/${encodePathSegment(filename)}`;
}

export function parseRoute(pathname = '/') {
  if (pathname === '/') return { view: 'home' };
  if (pathname === '/records') return { view: 'records' };

  const channelMatch = pathname.match(/^\/@([^/]+)$/);
  if (channelMatch) {
    const streamer = decodePathSegment(channelMatch[1]);
    if (streamer) return { view: 'channel', streamer };
  }

  const recordMatch = pathname.match(/^\/record\/([^/]+)$/);
  if (recordMatch) {
    const filename = decodePathSegment(recordMatch[1]);
    if (filename) return { view: 'record', filename };
  }

  return { view: 'notFound' };
}

export function liveUrl(streamer) {
  return `${API_BASE}/live/${encodePathSegment(streamer)}.m3u8`;
}

export function recordUrl(filename) {
  return `${API_BASE}/record/${encodePathSegment(filename)}`;
}

export function thumbnailUrl(filename, extension = 'jxl') {
  const basename = String(filename).replace(/\.[^.]+$/, '');
  return `${API_BASE}/record/${encodePathSegment(basename)}.${extension}`;
}

export function nextThumbnailExtension(extension) {
  return { jxl: 'avif', avif: 'png', png: null }[extension] ?? null;
}

export async function probeLive(streamer, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(liveUrl(streamer), {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return false;
    return (await response.text()).trimStart().startsWith('#EXTM3U');
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export function metadataForPath(pathname) {
  const defaultDescription = '瀏覽主播、觀看正在進行的直播與直播紀錄，並在即時聊天室一起參與。';
  const route = parseRoute(pathname);
  if (route.view === 'home') {
    return { title: 'OKTW Live — 直播、主播與直播紀錄', description: defaultDescription };
  }
  if (route.view === 'records') {
    return { title: '直播紀錄 — OKTW Live', description: '搜尋、篩選並播放 OKTW Live 的所有直播紀錄。' };
  }
  if (route.view === 'channel') {
    return { title: `${route.streamer} — OKTW Live`, description: `觀看 ${route.streamer} 的即時直播與過去直播紀錄。` };
  }
  if (route.view === 'record') {
    const match = route.filename.match(filenamePattern);
    if (match) return { title: `${match[1]} 直播紀錄 — OKTW Live`, description: `播放 ${route.filename} 直播紀錄。` };
  }
  return { title: '找不到頁面 — ON Live', description: defaultDescription };
}
