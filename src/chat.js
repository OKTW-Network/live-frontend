const MAX_MESSAGES = 200;

export function chatServerUrl({
  useProxy = import.meta.env?.DEV === true,
  locationImpl = globalThis.location,
} = {}) {
  if (!useProxy || !locationImpl) return 'wss://live.oktw.one/ws';
  const protocol = locationImpl.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${locationImpl.host}/__upstream/ws`;
}

export class ChatClient {
  constructor({
    server = chatServerUrl(),
    WebSocketImpl = globalThis.WebSocket,
    setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimer = (timer) => globalThis.clearTimeout(timer),
    onState = () => {},
    onViewerCount = () => {},
    onMessages = () => {},
  } = {}) {
    this.server = server;
    this.WebSocketImpl = WebSocketImpl;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onState = onState;
    this.onViewerCount = onViewerCount;
    this.onMessages = onMessages;
    this.socket = null;
    this.channel = '';
    this.nickname = 'anonymous';
    this.messages = [];
    this.messageSequence = 0;
    this.viewerCount = 0;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.intentionalClose = false;
  }

  connect(channel, nickname = 'anonymous') {
    this.disconnect(false);
    this.channel = channel;
    this.nickname = nickname || 'anonymous';
    this.intentionalClose = false;
    this.#open();
  }

  #open() {
    if (!this.channel || !this.WebSocketImpl) {
      this.onState('error');
      return;
    }
    this.onState('connecting');
    const socket = new this.WebSocketImpl(this.server);
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (socket !== this.socket) return;
      this.reconnectAttempt = 0;
      this.onState('open');
      this.#send({ method: 'setName', name: this.nickname });
      this.#send({ method: 'joinChannel', channelName: this.channel });
    });

    socket.addEventListener('message', (event) => {
      if (socket !== this.socket) return;
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      if ('nowViewerCount' in data) {
        this.viewerCount = Number(data.nowViewerCount) || 0;
        this.onViewerCount(this.viewerCount);
      }
      if (data.type === 'channelData' || (!('msg' in data) && !('message' in data))) return;
      const message = {
        id: `${data.uuid ?? 'anon'}-${Date.now()}-${this.messageSequence++}`,
        name: String(data.name || 'anonymous'),
        msg: String(data.msg ?? data.message ?? ''),
        receivedAt: Date.now(),
        uuid: data.uuid ?? null,
      };
      this.messages = [...this.messages, message].slice(-MAX_MESSAGES);
      this.onMessages(this.messages);
    });

    socket.addEventListener('error', () => {
      if (socket === this.socket) this.onState('error');
    });

    socket.addEventListener('close', () => {
      if (socket !== this.socket) return;
      this.socket = null;
      this.onState('closed');
      if (!this.intentionalClose) this.#scheduleReconnect();
    });
  }

  #scheduleReconnect() {
    const delay = Math.min(30000, 2000 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      if (!this.intentionalClose) this.#open();
    }, delay);
  }

  #send(payload) {
    if (!this.socket || this.socket.readyState !== 1) return false;
    this.socket.send(JSON.stringify(payload));
    return true;
  }

  setNickname(name) {
    this.nickname = name || 'anonymous';
    return this.#send({ method: 'setName', name: this.nickname });
  }

  sendMessage(message) {
    const text = String(message ?? '').trim();
    if (!text) return false;
    return this.#send({ method: 'sendBulletMessage', msg: text });
  }

  disconnect(reset = true) {
    this.intentionalClose = true;
    this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.close(1000, 'route change');
    this.reconnectAttempt = 0;
    if (reset) {
      this.messages = [];
      this.messageSequence = 0;
      this.viewerCount = 0;
      this.onMessages([]);
      this.onViewerCount(0);
      this.onState('closed');
    }
  }
}

export { MAX_MESSAGES };
