export const API_BASE = 'https://live.oktw.one';
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
      });
    }
  }
  return [...streamers.values()].sort(
    (a, b) => b.latestTimestamp - a.latestTimestamp || a.name.localeCompare(b.name),
  );
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

export function paginate(items, page = 1, pageSize = PAGE_SIZE) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(totalPages, Math.max(1, Number(page) || 1));
  const start = (safePage - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    page: safePage,
    totalPages,
    totalItems: items.length,
  };
}

const fullDateFormatter = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const shortDateFormatter = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

export function formatDate(timestamp) {
  return fullDateFormatter.format(new Date(timestamp * 1000));
}

export function formatShortDate(timestamp) {
  return shortDateFormatter.format(new Date(timestamp * 1000));
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
  if (value < 1024) return `${value} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let size = value;
  let unitIndex = -1;
  do {
    size /= 1024;
    unitIndex += 1;
  } while (size >= 1024 && unitIndex < units.length - 1);
  const digits = size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${units[unitIndex]}`;
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

export function livePath(streamer) {
  return `/live/${encodePathSegment(streamer)}`;
}

export function recordPath(filename) {
  return `/record/${encodePathSegment(filename)}`;
}

export function liveUrl(streamer) {
  return `${API_BASE}/live/${encodePathSegment(streamer)}.m3u8`;
}

export function recordUrl(filename) {
  return `${API_BASE}/record/${encodePathSegment(filename)}`;
}

export function thumbnailUrl(filename, extension = 'jxl') {
  return `${recordUrl(filename)}.${extension}`;
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
  const defaultDescription = '瀏覽實況主、播放直播與存檔，並在即時聊天室一起參與。';
  if (pathname === '/') {
    return { title: 'OKTW Live — 直播與存檔', description: defaultDescription, useSiteImage: true };
  }
  if (pathname === '/records') {
    return { title: '全部存檔 — OKTW Live', description: '搜尋、篩選並播放 OKTW Live 的所有直播存檔。', useSiteImage: false };
  }
  if (pathname.startsWith('/@')) {
    const streamer = decodePathSegment(pathname.slice(2));
    if (streamer) return { title: `@${streamer} — OKTW Live`, description: `觀看 @${streamer} 的直播入口與過去存檔。`, useSiteImage: false };
  }
  if (pathname.startsWith('/live/')) {
    const streamer = decodePathSegment(pathname.slice(6));
    if (streamer) return { title: `@${streamer} 直播 — OKTW Live`, description: `觀看 @${streamer} 的即時直播並參與聊天。`, useSiteImage: false };
  }
  if (pathname.startsWith('/record/')) {
    const filename = decodePathSegment(pathname.slice(8));
    const match = filename?.match(filenamePattern);
    if (filename && match) return { title: `${match[1]} 存檔 — OKTW Live`, description: `播放 ${filename} 直播存檔。`, useSiteImage: false };
  }
  return { title: '找不到頁面 — OKTW Live', description: defaultDescription, useSiteImage: false };
}
