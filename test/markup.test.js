import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('header statistics are the only primary navigation', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const header = html.slice(html.indexOf('<header'), html.indexOf('</header>') + '</header>'.length);

  assert.match(header, />ON LIVE<\/span>/);
  assert.doesNotMatch(header, />OKTW LIVE<\/span>/);
  assert.match(header, /<nav aria-label="主要導覽與平台統計"/);
  assert.match(header, /<a href="\/#live-now"[^>]*>.*直播中.*liveStreamers\.length.*<\/a>/s);
  assert.match(header, /<a href="\/#creators"[^>]*>.*主播.*streamers\.length.*<\/a>/s);
  assert.match(header, /<a href="\/records"[^>]*>.*紀錄.*records\.length.*<\/a>/s);
  assert.equal((header.match(/<nav\b/g) || []).length, 1);
  assert.doesNotMatch(header, /aria-label="平台統計"|>正在直播<|>直播紀錄</);
});
