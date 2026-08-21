import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatClient, MAX_MESSAGES } from '../src/chat.js';

class FakeSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    this.sent = [];
    FakeSocket.instances.push(this);
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  emit(type, payload = {}) {
    for (const handler of this.listeners.get(type) || []) handler(payload);
  }

  open() {
    this.readyState = 1;
    this.emit('open');
  }

  send(value) {
    this.sent.push(JSON.parse(value));
  }

  close() {
    this.readyState = 3;
    this.emit('close', { code: 1000 });
  }
}

test('sets nickname before joining the selected channel', () => {
  FakeSocket.instances = [];
  const states = [];
  const client = new ChatClient({ WebSocketImpl: FakeSocket, onState: (state) => states.push(state) });
  client.connect('bill96012', 'viewer');
  const socket = FakeSocket.instances[0];
  socket.open();
  assert.deepEqual(socket.sent, [
    { method: 'setName', name: 'viewer' },
    { method: 'joinChannel', channelName: 'bill96012' },
  ]);
  assert.deepEqual(states.slice(-2), ['connecting', 'open']);
});

test('updates viewer count, excludes channelData, and caps messages', () => {
  FakeSocket.instances = [];
  let count = 0;
  let messages = [];
  const client = new ChatClient({
    WebSocketImpl: FakeSocket,
    onViewerCount: (value) => { count = value; },
    onMessages: (value) => { messages = value; },
  });
  client.connect('record.mp4', 'viewer');
  const socket = FakeSocket.instances[0];
  socket.open();
  socket.emit('message', { data: JSON.stringify({ type: 'channelData', nowViewerCount: 7, uuid: 3 }) });
  assert.equal(count, 7);
  assert.equal(messages.length, 0);
  for (let index = 0; index < MAX_MESSAGES + 5; index += 1) {
    socket.emit('message', { data: JSON.stringify({ name: 'viewer', msg: `message-${index}`, uuid: 3 }) });
  }
  assert.equal(messages.length, MAX_MESSAGES);
  assert.equal(messages[0].msg, 'message-5');
  assert.equal(new Set(messages.map((message) => message.id)).size, MAX_MESSAGES);
});

test('sends messages and reconnects after an unexpected close', () => {
  FakeSocket.instances = [];
  const timers = [];
  const client = new ChatClient({
    WebSocketImpl: FakeSocket,
    setTimer: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    clearTimer: () => {},
  });
  client.connect('bill96012', 'viewer');
  const socket = FakeSocket.instances[0];
  socket.open();
  assert.equal(client.sendMessage(' hello '), true);
  assert.deepEqual(socket.sent.at(-1), { method: 'sendBulletMessage', msg: 'hello' });
  socket.readyState = 3;
  socket.emit('close', { code: 1006 });
  assert.equal(timers[0].delay, 2000);
  timers[0].callback();
  assert.equal(FakeSocket.instances.length, 2);
});
