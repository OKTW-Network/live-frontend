import { ref, onUnmounted } from 'vue'

const MAX_MESSAGES = 200

export const useChat = () => {
  const wsServer = 'wss://live.oktw.one/ws'
  const ws = ref(null)

  const messages = ref([])
  const nickname = ref(localStorage.getItem('config_nickname') ?? 'anonymous')
  const uuid = ref([])
  const viewerCount = ref(0)
  const readyState = ref(false)

  const setNickname = (name) => {
    localStorage.setItem('config_nickname', name)
    ws.value?.send(`{"method":"setName", "name":"${name}"}`)
  }
  const joinChannel = (channel) => {
    ws.value?.send(`{"method":"joinChannel","channelName":"${channel}"}`)
  }
  const sendMessage = (message) => {
    ws.value?.send(`{"method":"sendBulletMessage","msg":"${message}"}`)
  }

  const connect = (channel) => {
    ws.value = new WebSocket(wsServer)
    ws.value?.addEventListener('open', () => {
      setNickname(nickname.value)
      joinChannel(channel)
      readyState.value = true
    })
    ws.value?.addEventListener('close', (event) => {
      readyState.value = false
      if (event.code === 1006) setTimeout(() => connect(channel), 2000)
    })
    ws.value?.addEventListener('message', (event) => {
      const data = JSON.parse(event.data)
      if ('nowViewerCount' in data && data.uuid) {
        uuid.value.push(data.uuid)
        viewerCount.value = data.nowViewerCount
      }
      messages.value.push({
        ...data,
        receivedAt: Date.now(),
        id: `${data.uuid ?? 'anon'}-${Date.now()}-${messages.value.length}`
      })
      if (messages.value.length > MAX_MESSAGES) {
        messages.value = messages.value.slice(-MAX_MESSAGES)
      }
    })
    ws.value?.addEventListener('error', (e) => {
      console.error(e)
      readyState.value = false
    })
  }

  const disconnect = () => {
    ws.value?.close()
    ws.value = null
    messages.value = []
    uuid.value = []
    readyState.value = false
  }

  onUnmounted(() => {
    disconnect()
  })

  return {
    messages,
    nickname,
    uuid,
    viewerCount,
    readyState,
    setNickname,
    sendMessage,
    connect,
    disconnect
  }
}
