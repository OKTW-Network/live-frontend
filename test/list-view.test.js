import test from 'node:test';
import assert from 'node:assert/strict';
import { createListView } from '../src/list-view.js';
import { PAGE_SIZE } from '../src/utils.js';

test('record and channel lists share query behavior without leaking streamer filters', () => {
  const records = createListView({ includeStreamer: true });
  records.read('?q=panda&streamer=cute_panda&from=2026-08-20&sort=oldest');
  assert.deepEqual(records.filters, {
    query: 'panda', streamer: 'cute_panda', from: '2026-08-20', to: '', sort: 'oldest',
  });
  assert.equal(records.query(), '?q=panda&streamer=cute_panda&from=2026-08-20&sort=oldest');
  assert.equal(records.active, true);

  const channel = createListView({ includeStreamer: false });
  channel.read('?q=start&streamer=ignored&to=not-a-date&sort=oldest');
  assert.deepEqual(channel.filters, { query: 'start', from: '', to: '', sort: 'oldest' });
  assert.equal(channel.query(), '?q=start&sort=oldest');
  channel.clear();
  assert.equal(channel.active, false);
});

test('pagination and snapshots restore only matching filters and owners', () => {
  const list = createListView({ includeStreamer: false });
  list.read('?from=2026-08-20&to=2026-08-21');
  assert.equal(list.loadMore(PAGE_SIZE + 1), true);
  assert.equal(list.visibleCount, PAGE_SIZE * 2);

  const snapshot = list.snapshot(320, 'panda');
  assert.equal(list.canRestore(snapshot, 'panda'), true);
  assert.equal(list.canRestore(snapshot, 'other'), false);

  list.read('?from=2026-08-21&to=2026-08-20');
  assert.equal(list.rangeInvalid, true);
  assert.equal(list.loadMore(100), false);
  assert.equal(list.canRestore(snapshot, 'panda'), false);
});
