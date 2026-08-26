import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatComponent } from '../src/components/chat.js';

test('chat hides normal connection text and explains only transitional or failed states', () => {
  const chat = createChatComponent({ raw: (value) => value });
  chat.chatState = 'open';
  assert.equal(chat.chatStatusMessage(), '');
  chat.chatState = 'connecting';
  assert.equal(chat.chatStatusMessage(), '聊天室連線中…');
  chat.chatState = 'error';
  assert.equal(chat.chatStatusMessage(), '聊天室連線異常，正在重試。');
  chat.chatState = 'closed';
  assert.equal(chat.chatStatusMessage(), '聊天室已離線，正在重試。');
});
