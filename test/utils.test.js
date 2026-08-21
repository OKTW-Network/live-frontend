import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveStreamers,
  filterRecords,
  formatBytes,
  formatDuration,
  mapWithConcurrency,
  metadataForPath,
  nextThumbnailExtension,
  normalizeRecords,
  paginate,
  parseRecordEntry,
  probeLive,
  streamerPath,
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
});

test('filters, sorts, and paginates records', () => {
  const records = normalizeRecords(entries);
  const filtered = filterRecords(records, { streamer: 'jimchen5209-test', sort: 'oldest' });
  assert.equal(filtered.length, 2);
  assert.equal(filtered[0].timestamp, 1700000000);
  assert.deepEqual(paginate(filtered, 2, 1), { items: [filtered[1]], page: 2, totalPages: 2, totalItems: 2 });
});

test('formats duration, bytes, and @ routes', () => {
  assert.equal(formatDuration(3661.9), '01:01:01');
  assert.equal(formatBytes(2048), '2.00 KiB');
  assert.equal(streamerPath('name with space'), '/@name%20with%20space');
});

test('falls back through JXL, AVIF, PNG, then the placeholder', () => {
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

test('builds route-specific metadata without inherited item images', () => {
  assert.equal(metadataForPath('/').useSiteImage, true);
  assert.equal(metadataForPath('/@cute_panda').title, '@cute_panda — OKTW Live');
  assert.equal(metadataForPath('/record/cute_panda-1700000000.mp4').useSiteImage, false);
});
