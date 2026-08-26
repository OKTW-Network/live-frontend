import { ChatClient } from '../chat.js';

function storedNickname() {
  try { return localStorage.getItem('config_nickname') || 'anonymous'; } catch { return 'anonymous'; }
}

export function createChatComponent(Alpine) {
  return {
    chatClient: null,
    chatState: 'closed',
    chatMessages: [],
    chatViewerCount: 0,
    chatDraft: '',
    chatExpanded: false,
    nicknamePanelOpen: false,
    nickname: storedNickname(),

    connectChat(channel) {
      const client = new ChatClient({
        onState: (state) => { this.chatState = state; },
        onViewerCount: (count) => { this.chatViewerCount = count; },
        onMessages: (messages) => {
          const list = this.$refs.chatList;
          const shouldStick = !list || list.scrollHeight - list.scrollTop - list.clientHeight < 96;
          this.chatMessages = messages;
          if (shouldStick) Alpine.nextTick(() => list?.scrollTo({ top: list.scrollHeight, behavior: 'smooth' }));
        },
      });
      client.connect(channel, this.nickname);
      this.chatClient = client;
    },

    resetChat() {
      Alpine.raw(this.chatClient)?.disconnect();
      this.chatClient = null;
      this.chatState = 'closed';
      this.chatMessages = [];
      this.chatViewerCount = 0;
      this.chatDraft = '';
      this.chatExpanded = false;
      this.nicknamePanelOpen = false;
    },

    saveNickname() {
      this.nickname = this.nickname.trim() || 'anonymous';
      try { localStorage.setItem('config_nickname', this.nickname); } catch { /* Optional preference. */ }
      Alpine.raw(this.chatClient)?.setNickname(this.nickname);
      this.nicknamePanelOpen = false;
    },

    sendChat() {
      if (Alpine.raw(this.chatClient)?.sendMessage(this.chatDraft)) this.chatDraft = '';
    },

    chatStatusMessage() {
      return {
        connecting: '聊天室連線中…',
        error: '聊天室連線異常，正在重試。',
        closed: '聊天室已離線，正在重試。',
      }[this.chatState] || '';
    },
  };
}
