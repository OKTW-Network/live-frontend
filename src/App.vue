<script setup>
import { ref, onMounted, watch, computed } from 'vue'

import HeaderBlock from './components/sidebar/HeaderBlock.vue'
import StreamerList from './components/sidebar/StreamerList.vue'
import PlaylistView from './components/centerBlock/PlaylistView.vue'
import MediaPlayer from './components/centerBlock/MediaPlayer.vue'
import ChatView from './components/chatroom/ChatView.vue'
import ErrorBlankSlate from './components/ErrorBlankSlate.vue'
import AgeRestrictPage from './components/AgeRestrictPage.vue'

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

const playlistRef = ref(null)
const mobileMenuRef = ref(null)
const livestreamList = ref([])
const recordList = ref([])
const isError = ref(false)

// Age Restrict
const isAdult = ref(parseInt(localStorage.getItem('adult')) ?? 0)
const ageRestrict = (i) => {
  localStorage.setItem('adult', i)
  isAdult.value = i
}

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
  playlistRef.value?.scrollTo({ top: 0, left: 0, behavior: 'smooth' })
}

watch(
  () => currentPath.value,
  () => {
    if (mobileMenuRef.value?.classList.contains('is-visible')) mobileMenuRef.value?.classList.remove('is-visible')
    scrollToTop()
    isPlayable.value = currentPath.value.split('/').length > 2

    refreshChat()
  }
)

const onDrawerBackgroundClick = (event) => {
  if (event.target.classList.contains('ts-app-drawer')) mobileMenuRef.value?.classList.remove('is-visible')
}

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
  <AgeRestrictPage
    v-else-if="!isAdult"
    @age-restrict="ageRestrict"
  />
  <div v-else class="cell ts-app-layout is-horizontal is-full">
    <!-- StreamerList for desktop user -->
    <div id="sidebar" class="tablet-:has-hidden cell is-scrollable">
      <HeaderBlock />
      <StreamerList v-if="livestreamList" :livestream-list="livestreamList" :path="currentPath" />
    </div>
    <div class="cell is-fluid">
      <div class="ts-app-layout is-vertical">
        <!-- StreamerList for mobile user -->
        <div class="cell desktop+:has-hidden">
          <div class="ts-app-topbar">
            <div class="start">
              <a class="item" data-toggle="menu:is-visible">
                <span class="ts-icon is-bars-icon"></span>
              </a>
              <div class="item is-text">StreamerList</div>
            </div>
          </div>
          <div
            ref="mobileMenuRef"
            class="ts-app-drawer is-left is-small"
            data-name="menu"
            @click="onDrawerBackgroundClick"
          >
            <div class="content is-scrollable">
              <HeaderBlock />
              <StreamerList
                v-if="livestreamList"
                :livestream-list="livestreamList"
                :path="currentPath"
              />
            </div>
          </div>
        </div>
        <div ref="playlistRef" class="cell ts-app-layout is-vertical is-fluid is-scrollable">
          <!-- MediaPlayer -->
          <div v-if="isPlayable" class="cell" style="display: inline-flex">
            <MediaPlayer
              v-if="livestreamList"
              :current-path="currentPath"
              :list="recordList.concat(livestreamList.filter((i) => i.isLive))"
            />
          </div>
          <div class="cell">
            <!-- Chat for mobile user -->
            <div v-if="isPlayable" id="mobileChat" class="desktop+:has-hidden">
              <ChatView
                v-if="isMobile"
                :viewer-count="viewerCount"
                :messages="messages"
                :uuid="uuid"
                :nickname="nickname"
                :ready="readyState"
                @set-nickname="setNickname"
                @send-message="sendMessage"
              />
              <div class="ts-divider" />
            </div>
            <!-- Playlist -->
            <PlaylistView
              :current-path="currentPath"
              :list="recordList.concat(livestreamList.filter((i) => i.isLive))"
              @top="scrollToTop"
            />
          </div>
        </div>
      </div>
    </div>
    <!-- Chat for desktop user -->
    <div v-if="isPlayable" id="chatBar" class="tablet-:has-hidden cell">
      <ChatView
        v-if="!isMobile"
        :viewer-count="viewerCount"
        :messages="messages"
        :uuid="uuid"
        :nickname="nickname"
        :ready="readyState"
        @set-nickname="setNickname"
        @send-message="sendMessage"
      />
    </div>
  </div>
</template>

<style scoped>
#sidebar {
  width: 13%;
}
#chatBar {
  width: 18%;
}
#mobileChat {
  height: 65vh;
}
.ts-app-topbar {
  --accent-color: var(--ts-gray-100);
  --accent-foreground-color: var(--ts-gray-900);
}
.content.is-scrollable {
  overflow-y: auto;
}
</style>
