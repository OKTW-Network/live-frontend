import test from 'node:test';
import assert from 'node:assert/strict';
import {
  API_BASE,
  deriveStreamers,
  filterRecords,
  isDateRangeInverted,
  liveThumbnailUrl,
  normalizeRecords,
  parseRoute,
  probeLive,
  recordUrl,
  serializeRecordQuery,
  parseRecordQuery,
} from '../src/utils.js';

const entries = [
  { format: { filename: 'jimchen5209-test-1700000000.mp4', size: '2048', duration: '3661.9' } },
  { format: { filename: 'bill96012-1800000000.flv', size: '1024', duration: '59.2' } },
  { format: { filename: 'jimchen5209-test-1750000000.mp4', size: '4096', duration: '61' } },
];

test('normalizes records, derives streamers, and filters by streamer', () => {
  const records = normalizeRecords([...entries, { format: { filename: 'broken.mp4', size: '1', duration: '2' } }]);
  assert.equal(records.length, 3);
  assert.equal(records[0].filename, 'bill96012-1800000000.flv');

  const streamers = deriveStreamers(records);
  assert.deepEqual(streamers.map(({ name, recordCount }) => ({ name, recordCount })), [
    { name: 'bill96012', recordCount: 1 },
    { name: 'jimchen5209-test', recordCount: 2 },
  ]);

  const filtered = filterRecords(records, { streamer: 'jimchen5209-test', sort: 'oldest' });
  assert.equal(filtered.length, 2);
  assert.equal(filtered[0].timestamp, 1700000000);
});

test('parses supported routes and serializes record filters without legacy page state', () => {
  assert.deepEqual(parseRoute('/'), { view: 'home' });
  assert.deepEqual(parseRoute('/records'), { view: 'records' });
  assert.deepEqual(parseRoute('/@name%20with%20space'), { view: 'channel', streamer: 'name with space' });
  assert.deepEqual(parseRoute('/record/cute_panda-1700000000.mp4'), { view: 'record', filename: 'cute_panda-1700000000.mp4' });
  assert.deepEqual(parseRoute('/live/cute_panda'), { view: 'notFound' });

  assert.deepEqual(parseRecordQuery('?q=panda&streamer=cute_panda&sort=oldest&page=8'), {
    query: 'panda',
    streamer: 'cute_panda',
    from: '',
    to: '',
    sort: 'oldest',
  });
  assert.equal(
    serializeRecordQuery({ query: 'panda', streamer: 'cute_panda', sort: 'oldest', page: 8 }),
    '?q=panda&streamer=cute_panda&sort=oldest',
  );
});

test('filters inclusive Asia/Taipei calendar days and serializes date ranges', () => {
  const timestamp = (value) => Date.parse(value) / 1000;
  const records = [
    { streamer: 'panda', filename: 'start.mp4', timestamp: timestamp('2026-08-20T00:00:00+08:00') },
    { streamer: 'panda', filename: 'end.mp4', timestamp: timestamp('2026-08-21T23:59:59+08:00') },
    { streamer: 'panda', filename: 'outside.mp4', timestamp: timestamp('2026-08-22T00:00:00+08:00') },
  ];
  assert.deepEqual(
    filterRecords(records, { from: '2026-08-20', to: '2026-08-21' }).map((record) => record.filename),
    ['start.mp4', 'end.mp4'],
  );
  assert.equal(isDateRangeInverted({ from: '2026-08-22', to: '2026-08-21' }), true);
  assert.deepEqual(filterRecords(records, { from: '2026-08-22', to: '2026-08-21' }), []);
  assert.equal(
    serializeRecordQuery({ streamer: 'panda', from: '2026-08-20', to: '2026-08-21' }),
    '?streamer=panda&from=2026-08-20&to=2026-08-21',
  );
});

test('treats failed or invalid live probes as offline', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async () => { throw new Error('offline'); };
  assert.equal(await probeLive('test', { timeoutMs: 10 }), false);

  globalThis.fetch = async () => ({ ok: true, text: async () => '#EXTM3U\n' });
  assert.equal(await probeLive('test', { timeoutMs: 10 }), true);

  globalThis.fetch = async () => ({ ok: true, text: async () => 'not hls' });
  assert.equal(await probeLive('test', { timeoutMs: 10 }), false);
});

test('recordUrl maps .flv filenames to .mp4 and leaves other extensions unchanged', () => {
  assert.equal(recordUrl('streamer-123.flv'), `${API_BASE}/record/streamer-123.mp4`);
  assert.equal(recordUrl('streamer-123.FLV'), `${API_BASE}/record/streamer-123.mp4`);
  assert.equal(recordUrl('streamer-123.mp4'), `${API_BASE}/record/streamer-123.mp4`);
});

test('builds a cache-busted live thumbnail URL independently from record thumbnails', () => {
  assert.equal(liveThumbnailUrl('cute panda'), `${API_BASE}/live/cute%20panda.png`);
  assert.equal(liveThumbnailUrl('cute panda', 123), `${API_BASE}/live/cute%20panda.png?v=123`);
});
