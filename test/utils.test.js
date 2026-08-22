import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PAGE_SIZE,
  createRecordViewSnapshot,
  deriveStreamers,
  filterRecords,
  formatBytes,
  formatDate,
  formatDuration,
  mapWithConcurrency,
  metadataForPath,
  nextThumbnailExtension,
  normalizeRecords,
  orderStreamersByStatus,
  parseRecordQuery,
  parseRecordEntry,
  parseRoute,
  probeLive,
  recordViewSnapshotMatches,
  selectLiveStreamers,
  serializeRecordQuery,
  streamerPath,
  thumbnailUrl,
} from '../src/utils.js';

const entries = [
  { format: { filename: 'jimchen5209-test-1700000000.mp4', size: '2048', duration: '3661.9' } },
  { format: { filename: 'bill96012-1800000000.flv', size: '1024', duration: '59.2' } },
  { format: { filename: 'jimchen5209-test-1750000000.mp4', size: '4096', duration: '61' } },
];

test('parses a filename from the trailing timestamp and extension', () => {
  assert.deepEqual(parseRecordEntry(entries[0]), {
    filename: 'jimchen5209-test-1700000000.mp4',
    streamer: 'jimchen5209-test',
    timestamp: 1700000000,
    extension: 'mp4',
    size: 2048,
    duration: 3661.9,
  });
});

test('rejects malformed records and sorts newest first', () => {
  const records = normalizeRecords([...entries, { format: { filename: 'broken.mp4', size: '1', duration: '2' } }]);
  assert.equal(records.length, 3);
  assert.equal(records[0].filename, 'bill96012-1800000000.flv');
});

test('derives unique streamers ordered by latest activity', () => {
  const streamers = deriveStreamers(normalizeRecords(entries));
  assert.deepEqual(streamers.map(({ name, recordCount }) => ({ name, recordCount })), [
    { name: 'bill96012', recordCount: 1 },
    { name: 'jimchen5209-test', recordCount: 2 },
  ]);
  assert.equal(streamers[1].previewFilename, 'jimchen5209-test-1750000000.mp4');
});

test('selects live streamers and orders live channels before recent offline channels', () => {
  const streamers = deriveStreamers(normalizeRecords(entries));
  const statuses = { bill96012: 'offline', 'jimchen5209-test': 'online' };
  assert.deepEqual(selectLiveStreamers(streamers, statuses).map(({ name }) => name), ['jimchen5209-test']);
  assert.deepEqual(orderStreamersByStatus(streamers, statuses).map(({ name }) => name), ['jimchen5209-test', 'bill96012']);
});

test('filters and sorts records', () => {
  const records = normalizeRecords(entries);
  const filtered = filterRecords(records, { streamer: 'jimchen5209-test', sort: 'oldest' });
  assert.equal(filtered.length, 2);
  assert.equal(filtered[0].timestamp, 1700000000);
});

test('parses only the supported routes and rejects the removed live route', () => {
  assert.deepEqual(parseRoute('/'), { view: 'home' });
  assert.deepEqual(parseRoute('/records'), { view: 'records' });
  assert.deepEqual(parseRoute('/@name%20with%20space'), { view: 'channel', streamer: 'name with space' });
  assert.deepEqual(parseRoute('/record/cute_panda-1700000000.mp4'), { view: 'record', filename: 'cute_panda-1700000000.mp4' });
  assert.deepEqual(parseRoute('/live/cute_panda'), { view: 'notFound' });
  assert.deepEqual(parseRoute('/records/'), { view: 'notFound' });
});

test('serializes record filters without legacy page state', () => {
  assert.deepEqual(parseRecordQuery('?q=panda&streamer=cute_panda&sort=oldest&page=8'), {
    query: 'panda',
    streamer: 'cute_panda',
    sort: 'oldest',
  });
  assert.equal(
    serializeRecordQuery({ query: 'panda', streamer: 'cute_panda', sort: 'oldest', page: 8 }),
    '?q=panda&streamer=cute_panda&sort=oldest',
  );
});

test('normalizes and compares record view restoration snapshots', () => {
  const snapshot = createRecordViewSnapshot({
    filters: { query: 'panda', streamer: '', sort: 'newest' },
    visibleCount: 50.9,
    scrollY: 812.5,
  });
  assert.deepEqual(snapshot, {
    filters: { query: 'panda', streamer: '', sort: 'newest' },
    visibleCount: 50,
    scrollY: 812.5,
  });
  assert.equal(recordViewSnapshotMatches(snapshot, { query: 'panda', streamer: '', sort: 'newest' }), true);
  assert.equal(recordViewSnapshotMatches(snapshot, { query: 'other', streamer: '', sort: 'newest' }), false);
  assert.equal(createRecordViewSnapshot({ visibleCount: 1 }).visibleCount, PAGE_SIZE);
});

test('formats duration, file size units, Taipei time, and @ routes', () => {
  assert.equal(formatDuration(3661.9), '01:01:01');
  assert.equal(formatBytes(1023), '1,023 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1024 ** 2), '1 MB');
  assert.equal(formatBytes(1024 ** 3), '1 GB');
  assert.equal(formatBytes(1024 ** 4), '1 TB');
  assert.match(formatDate(1700000000), /^2023\/11\/15.*06:13$/);
  assert.equal(streamerPath('name with space'), '/@name%20with%20space');
});

test('falls back through JXL, AVIF, PNG, then the placeholder', () => {
  assert.match(thumbnailUrl('cute_panda-1700000000.mp4', 'avif'), /\/record\/cute_panda-1700000000\.avif$/);
  assert.equal(nextThumbnailExtension('jxl'), 'avif');
  assert.equal(nextThumbnailExtension('avif'), 'png');
  assert.equal(nextThumbnailExtension('png'), null);
});

test('treats failed or invalid live probes as offline', async () => {
  assert.equal(await probeLive('test', { fetchImpl: async () => { throw new Error('offline'); }, timeoutMs: 10 }), false);
  assert.equal(await probeLive('test', { fetchImpl: async () => ({ ok: true, text: async () => '#EXTM3U\n' }), timeoutMs: 10 }), true);
  assert.equal(await probeLive('test', { fetchImpl: async () => ({ ok: true, text: async () => 'not hls' }), timeoutMs: 10 }), false);
});

test('limits concurrent work', async () => {
  let active = 0;
  let maxActive = 0;
  const output = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(output, [2, 4, 6, 8, 10]);
  assert.equal(maxActive, 2);
});

test('builds route-specific metadata', () => {
  assert.equal(metadataForPath('/').title, 'OKTW Live — 直播、主播與直播紀錄');
  assert.equal(metadataForPath('/records').title, '直播紀錄 — OKTW Live');
  assert.equal(metadataForPath('/@cute_panda').title, 'cute_panda — OKTW Live');
  assert.equal(metadataForPath('/record/cute_panda-1700000000.mp4').title, 'cute_panda 直播紀錄 — OKTW Live');
  assert.equal(metadataForPath('/live/cute_panda').title, '找不到頁面 — ON Live');
});
