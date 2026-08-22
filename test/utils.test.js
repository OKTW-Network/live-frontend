import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveStreamers,
  filterRecords,
  normalizeRecords,
  parseRoute,
  probeLive,
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
    sort: 'oldest',
  });
  assert.equal(
    serializeRecordQuery({ query: 'panda', streamer: 'cute_panda', sort: 'oldest', page: 8 }),
    '?q=panda&streamer=cute_panda&sort=oldest',
  );
});

test('treats failed or invalid live probes as offline', async () => {
  assert.equal(await probeLive('test', { fetchImpl: async () => { throw new Error('offline'); }, timeoutMs: 10 }), false);
  assert.equal(await probeLive('test', { fetchImpl: async () => ({ ok: true, text: async () => '#EXTM3U\n' }), timeoutMs: 10 }), true);
  assert.equal(await probeLive('test', { fetchImpl: async () => ({ ok: true, text: async () => 'not hls' }), timeoutMs: 10 }), false);
});
