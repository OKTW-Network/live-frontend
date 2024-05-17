import { ref, onUnmounted } from 'vue'

const wsServer = 'wss://live.oktw.one/ws'
const wsSetName = (name) => JSON.stringify({ method: 'setName', name })
const wsJoinChannel = (channelName) => JSON.stringify({ method: 'joinChannel', channelName })
const wsSendBulletMessage = (msg) => JSON.stringify({ method: 'sendBulletMessage', msg })

export const useChat = () => {
  const ws = ref(null)

  const messages = ref([])
  const nickname = ref(localStorage.getItem('config_nickname') ?? 'anonymous')
  const uuid = ref([])
  const viewerCount = ref(0)
  const readyState = ref(false)

  const setNickname = (name) => {
    localStorage.setItem('config_nickname', name)
    nickname.value = name
    ws.value?.send(wsSetName(name))
  }
  const joinChannel = (channel) => {
    ws.value?.send(wsJoinChannel(channel))
  }
  const sendMessage = (message) => {
    ws.value?.send(wsSendBulletMessage(message))
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
      messages.value.push(data)
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

export const useWatchTogether = () => {
  const ws = ref(null)

  const syncedTime = ref(-1)
  const nickname = ref(localStorage.getItem('config_nickname') ?? 'anonymous')
  const ownUuid = ref(0)
  const isHost = ref(false)
  const hostName = ref('anonymous')
  const hostUuid = ref(0)
  const locked = ref(true)
  const viewerCount = ref(0)
  const readyState = ref(false)

  const setNickname = (name) => {
    localStorage.setItem('config_nickname', name)
    nickname.value = name
    ws.value?.send(wsSetName(name))
  }
  const joinChannel = (channel) => {
    ws.value?.send(wsJoinChannel(channel))
  }
  const syncTime = (time) => {
    if (locked.value && !isHost.value) return
    ws.value?.send(wsSendBulletMessage(JSON.stringify({ type: 'syncTime', value: time })))
  }
  const getConfig = () => {
    ws.value?.send(wsSendBulletMessage(JSON.stringify({ type: 'getProp' })))
  }
  const sendConfig = (hostname, hostUuid, lockState) => {
    ws.value?.send(
      wsSendBulletMessage(JSON.stringify({ type: 'setProp', hostname, hostUuid, lockState }))
    )
  }

  const setLocked = (newVal) => {
    if (isHost.value) {
      locked.value = newVal
      sendConfig(nickname.value, ownUuid.value, locked.value)
    }
  }
  const onWatchTogetherMessage = (data, uuid) => {
    switch (data.type) {
      case 'syncTime':
        if (uuid === hostUuid.value) break
        syncedTime.value = data.value
        break
      case 'getProp':
        if (isHost.value && hostUuid.value !== 0) {
          sendConfig(nickname.value, ownUuid.value, locked.value)
        }
        break
      case 'setProp':
        if (uuid !== ownUuid.value) {
          isHost.value = false
        }
        hostName.value = data.hostname
        hostUuid.value = data.hostUuid
        locked.value = data.lockState
        break
    }
  }

  const connect = (channel, code) => {
    ws.value = new WebSocket(wsServer)

    ws.value?.addEventListener('open', () => {
      setNickname(nickname.value)
      joinChannel(`${channel}/${code}`)
      readyState.value = true
    })
    ws.value?.addEventListener('close', (event) => {
      readyState.value = false
      if (event.code === 1006) setTimeout(() => connect(channel), 2000)
    })
    ws.value?.addEventListener('message', (event) => {
      const data = JSON.parse(event.data)
      switch (data.type) {
        case 'channelData':
          ownUuid.value = data.uuid
          viewerCount.value = data.nowViewerCount
          if (data.nowViewerCount === 1) {
            isHost.value = true
            hostName.value = nickname.value
            hostUuid.value = ownUuid.value
          }
          getConfig()
          break
        case 'bulletMessage':
          onWatchTogetherMessage(data, data.uuid)
          break
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
    syncedTime.value = -1
    ownUuid.value = 0
    isHost.value = false
    hostName.value = ''
    hostUuid.value = 0
    locked.value = true
    readyState.value = false
  }

  onUnmounted(() => {
    disconnect()
  })

  return {
    syncedTime,
    nickname,
    isHost,
    hostName,
    locked,
    viewerCount,
    readyState,
    setNickname,
    syncTime,
    setLocked,
    connect,
    disconnect
  }
}
