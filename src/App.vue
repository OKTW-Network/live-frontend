<script setup>
import { ref, onMounted, watch, computed } from 'vue'

import HeaderBlock from './components/sidebar/HeaderBlock.vue'
import StreamerList from './components/sidebar/StreamerList.vue'
import PlaylistView from './components/centerBlock/PlaylistView.vue'
import MediaPlayer from './components/centerBlock/MediaPlayer.vue'
import ChatView from './components/chatroom/ChatView.vue'
import ErrorBlankSlate from './components/ErrorBlankSlate.vue'

import { useViewport } from './util/viewport'
import { useChat } from './util/chat'

const liveUrl = '/live'
const recordUrl = '/record'
const listUrl = `${recordUrl}/list.json`

const {
  messages,
  viewerCount,
  uuid,
  nickname,
  readyState,
  setNickname,
  sendMessage,
  connect,
  disconnect
} = useChat()

const { viewWidth } = useViewport()

const centerRef = ref(null)
const playlistRef = ref(null)
const livestreamList = ref([])
const recordList = ref([])
const isError = ref(false)

const isMobile = computed(() => viewWidth.value <= 1023)

// Custom Routing
const currentPath = ref(window.location.hash)
window.addEventListener('hashchange', () => {
  currentPath.value = window.location.hash
})

const isPlayable = ref(currentPath.value.split('/').length > 2)

const refreshChat = () => {
  if (isPlayable.value) {
    const channel = currentPath.value.split('/').at(-1)
    disconnect()
    connect(channel)
  } else {
    disconnect()
  }
}

onMounted(async () => {
  refreshChat()
  // Data fetching
  recordList.value = await fetch(listUrl)
    .then((res) => res.json())
    .then((list) => {
      if (list.length <= 0) throw 'List empty.'
      return list
        .filter((e) => 'format' in e && e.format.size != 0)
        .map((e) => {
          const filename = e.format.filename.split('/').at(-1)
          return {
            streamer: filename.substring(0, filename.length - 15),
            publishTime: new Date(
              parseInt(filename.substring(filename.length - 14, filename.length - 4) * 1000)
            ),
            duration: e.format.duration,
            src: `${recordUrl}/${filename.replace('flv', 'mp4')}`,
            name: filename
          }
        })
        .sort(
          // 我就想整理 爽
          (a, b) => a.publishTime - b.publishTime
        )
    })
    .catch(() => (isError.value = true))

  livestreamList.value = (
    await Promise.all(
      Array.from(new Set(recordList.value.toReversed().map((i) => i.streamer)).values()).map(
        async (i) => {
          const url_livestream = `${liveUrl}/${i}.m3u8`
          return {
            streamer: i,
            publishTime: new Date(Date.now()),
            duration: '0',
            src: url_livestream,
            name: `${i}.m3u8`,
            isLive: (await fetch(url_livestream)).ok
          }
        }
      )
    )
  ).sort((a, b) => (a.isLive === b.isLive ? 0 : a.isLive ? -1 : 1))
})

// 來點回頂部
const scrollToTop = () => {
  centerRef.value?.scrollTo({ top: 0, left: 0, behavior: 'smooth' })
  playlistRef.value?.scrollTo({ top: 0, left: 0, behavior: 'smooth' })
}

watch(
  () => currentPath.value,
  () => {
    const menu = document.getElementById('menu-mobile')
    if (!menu.getAttribute('class').match('has-hidden'))
      menu.setAttribute('class', `${menu.getAttribute('class')} has-hidden`)
    scrollToTop()
    isPlayable.value = currentPath.value.split('/').length > 2

    refreshChat()
  }
)

// 相容舊的
const p = currentPath.value.split('/').at(-1)
if (currentPath.value?.startsWith('#record')) {
  // #record/cute_panda-1698758357.mp4
  window.location.replace(`#profile/${p.split('-').at(0)}/${p}`) // #profile/cute_panda/cute_panda-1698758357.mp4
} else if (currentPath.value?.startsWith('#live')) {
  // #live/cute_panda
  window.location.replace(`#profile/${p.split('-').at(0)}/${p.split('-').at(0)}.m3u8`) // #profile/cute_panda/cute_panda.m3u8
}
</script>

<template>
  <ErrorBlankSlate v-if="isError" style="height: 100vh; width: 100vw" />
  <div v-else class="cell ts-app-layout is-horizontal is-full">
    <!-- StreamerList for desktop user -->
    <div id="sidebar" class="tablet-:has-hidden cell is-scrollable">
      <HeaderBlock />
      <StreamerList v-if="livestreamList" :livestream-list="livestreamList" :path="currentPath" />
    </div>
    <div ref="centerRef" class="cell is-fluid" :class="{ 'is-scrollable': !isMobile }">
      <div class="ts-app-layout is-vertical">
        <!-- StreamerList for mobile user -->
        <div class="cell ts-app-topbar desktop+:has-hidden">
          <div class="start">
            <a class="item" data-toggle="menu:has-hidden">
              <span class="ts-icon is-bars-icon"></span>
            </a>
            <div class="item is-text">StreamerList</div>
          </div>
          <div id="menu-mobile" class="content has-hidden" data-name="menu">
            <HeaderBlock />
            <StreamerList
              v-if="livestreamList"
              :livestream-list="livestreamList"
              :path="currentPath"
            />
          </div>
        </div>
        <!-- MediaPlayer -->
        <div v-if="isPlayable" class="cell" style="display: inline-flex">
          <MediaPlayer
            v-if="livestreamList"
            :current-path="currentPath"
            :list="recordList.concat(livestreamList.filter((i) => i.isLive))"
          />
        </div>
        <!-- playlistRef -->
        <div ref="playlistRef" class="cell" :class="{ 'has-full-width is-scrollable': isMobile }">
          <!-- Chat for mobile user -->
          <ChatView
            v-if="isMobile && isPlayable"
            style="height: 60vh"
            :viewer-count="viewerCount"
            :messages="messages"
            :uuid="uuid"
            :nickname="nickname"
            :ready="readyState"
            @set-nickname="setNickname"
            @send-message="sendMessage"
          />
          <div class="ts-divider"></div>
          <!-- Playlist -->
          <PlaylistView
            :current-path="currentPath"
            :list="recordList.concat(livestreamList.filter((i) => i.isLive))"
            @top="scrollToTop"
          />
        </div>
      </div>
    </div>
    <!-- Chat for desktop user -->
    <ChatView
      v-if="!isMobile && isPlayable"
      id="chatBar"
      :viewer-count="viewerCount"
      :messages="messages"
      :uuid="uuid"
      :nickname="nickname"
      :ready="readyState"
      @set-nickname="setNickname"
      @send-message="sendMessage"
    />
  </div>
</template>

<style scoped>
#sidebar {
  width: 13%;
}
#chatBar {
  width: 18%;
}
</style>
