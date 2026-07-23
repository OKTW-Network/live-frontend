<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { debounce } from 'lodash'

import VolumeControl from './OverlayPlayer/VolumeControl.vue'
import ActionSnackbar from './OverlayPlayer/ActionSnackBar.vue'
import ErrorBlankSlate from '../ErrorBlankSlate.vue'

const props = defineProps({
  resource: {
    type: Object,
    required: true
  },
  qualityList: {
    type: Array,
    default: () => []
  },
  currentQuality: {
    type: Number,
    default: -1
  },
  time: {
    type: String,
    required: false,
    default: undefined
  },
  isError: {
    type: Boolean,
    default: false
  }
})
defineEmits(['change-quality', 'copy-link', 'copy-time-link'])

// Handle time code
const restoreTime = () => {
  if (props.time && !isNaN(props.time)) {
    const t = Math.max(Math.min(parseInt(props.time), duration.value || Infinity), 0)
    draggingCurrentTime.value = t
    setTime()
  }
}

// Handle touch mode
const touchMode = ref(false)
const isTouch = (event) => event?.pointerType === 'touch'

// Handle snack bar
const actionSnackBarRef = ref(null)

// Handle video element
const videoRef = ref(null)

const overlayVideoRef = ref(null)

const progressRangeDesktopRef = ref(null)
const progressRangeTouchRef = ref(null)
const timeTextRef = ref(null)

const isVideoError = ref(false)

const isBuffering = ref(false)

const isPaused = ref(true)

const isFullscreen = ref(false)

// Reactive currentTime is only updated on whole-second changes (share link etc.).
// Hot path during playback writes the range and clock via DOM to avoid Vue re-renders.
const currentTime = ref(0)

const draggingCurrentTime = ref(undefined)

const duration = ref(0)

const durationText = computed(() => timeToText(duration.value))

const playbackRate = ref(1)

const writeProgressDom = (t) => {
  const value = String(t)
  if (progressRangeDesktopRef.value) progressRangeDesktopRef.value.value = value
  if (progressRangeTouchRef.value) progressRangeTouchRef.value.value = value
  if (timeTextRef.value) timeTextRef.value.textContent = timeToText(t)
}

// Split media UI sync so timeupdate does not rewrite unrelated state every tick.
// When controls are auto-hidden, skip all progress work (DOM + Vue) until shown again.
const syncCurrentTime = () => {
  if (!controlsVisible && draggingCurrentTime.value === undefined) return

  if (draggingCurrentTime.value !== undefined) {
    writeProgressDom(draggingCurrentTime.value)
    return
  }
  const t = videoRef.value?.currentTime ?? 0
  writeProgressDom(t)
  // Keep Vue currentTime at second resolution for share/copy-time only.
  if (Math.floor(t) !== Math.floor(currentTime.value)) {
    currentTime.value = t
  }
}

const syncDuration = () => {
  duration.value = videoRef.value?.duration ?? 0
}

const syncPlayState = () => {
  isPaused.value = videoRef.value?.paused ?? true
}

const syncMuteState = () => {
  isMuted.value = videoRef.value?.muted ?? false
}

const syncFullscreen = () => {
  isFullscreen.value = document.fullscreenElement !== null
}

const syncPlaybackRate = () => {
  playbackRate.value = videoRef.value?.playbackRate ?? 1
}

const syncAllFromVideo = () => {
  isBuffering.value = false
  syncCurrentTime()
  syncDuration()
  syncPlayState()
  syncMuteState()
  syncFullscreen()
  syncPlaybackRate()
}

const handlePlayerLoaded = () => {
  syncAllFromVideo()
  restoreTime()
  showUIAndResetAutoHideTimer()

  // Try autoplay
  const play = videoRef.value.play()
  if (play) {
    play.catch((error) => {
      if (error.name === 'NotAllowedError') {
        videoRef.value.muted = true
        actionSnackBarRef.value?.emitSnackbar('volumeUnavailable')
        videoRef.value.play()
      }
    })
  }
}

const handlePlayerPlaying = () => {
  isBuffering.value = false
  isVideoError.value = false
}

const handlePlayerError = (event) => {
  console.error(`Video error: ${event.target.error.code} (${event.target.error.message})`)
  isBuffering.value = false
  isVideoError.value = true

  // Try recover video
  // MEDIA_ERR_DECODE
  if (event.target.error.code === 3) {
    videoRef.value.pause()
    const time = videoRef.value.currentTime
    videoRef.value.load()
    videoRef.value.currentTime = time
    videoRef.value.play()
  }
}

const playbackRateList = ref([
  { value: 0.25, text: '0.25x' },
  { value: 0.5, text: '0.5x' },
  { value: 1, text: '1x' },
  { value: 1.5, text: '1.5x' },
  { value: 2, text: '2x' },
  { value: 3, text: '3x' },
  { value: 5, text: '5x' }
])

const setPlaybackRate = (rate) => {
  videoRef.value.playbackRate = rate
  syncPlaybackRate()
}

const setTime = () => {
  const t = draggingCurrentTime.value ?? currentTime.value
  draggingCurrentTime.value = undefined
  if (videoRef.value) videoRef.value.currentTime = t
  currentTime.value = t
  writeProgressDom(t)
}

// Create debounced seek once (lodash.debounce returns a new function each call).
const debouncedSetTime = debounce(setTime, 500)

const handleSeekInput = (event) => {
  const t = parseFloat(event.target.value)
  if (isNaN(t)) return
  draggingCurrentTime.value = t
  writeProgressDom(t)
  debouncedSetTime()
}

const seekForward = () => {
  const base = videoRef.value?.currentTime ?? currentTime.value
  draggingCurrentTime.value = Math.min(base + 5, duration.value || Infinity)
  setTime()
  actionSnackBarRef.value?.emitSnackbar('forward')
}

const seekBackward = () => {
  const base = videoRef.value?.currentTime ?? currentTime.value
  draggingCurrentTime.value = Math.max(base - 5, 0)
  setTime()
  actionSnackBarRef.value?.emitSnackbar('backward')
}

const togglePlay = (showAction = false) => {
  if (!props.resource) return
  if (videoRef.value.paused) {
    videoRef.value.play()
  } else {
    videoRef.value.pause()
  }
  syncPlayState()
  if (showAction === true) {
    actionSnackBarRef.value?.emitSnackbar(videoRef.value.paused ? 'pause' : 'play')
  }
}

const toggleFullscreen = () => {
  if (!props.resource) return
  if (!document.fullscreenElement) {
    overlayVideoRef.value?.requestFullscreen().then(() => {
      screen.orientation.lock('landscape').catch(() => {})
    }).catch((err) => {
      console.error(`Error attempting to enable fullscreen mode: ${err.message} (${err.name})`)
    })
  } else {
    document.exitFullscreen()
    screen.orientation.unlock().catch(() => {})
  }
}

// Handle video volume
// Web Audio boost is created once, only when volume > 100%, so typical
// playback can stay on native video.volume (cheaper on Firefox).
let videoAmplifier = null

const ensureAmplifier = () => {
  if (videoAmplifier || !videoRef.value) return videoAmplifier
  const context = new (window.AudioContext || window.webkitAudioContext)()
  const source = context.createMediaElementSource(videoRef.value)
  const gain = context.createGain()
  source.connect(gain)
  gain.connect(context.destination)
  gain.gain.value = 1
  videoAmplifier = {
    context,
    amplify(multiplier) {
      gain.gain.value = multiplier
    }
  }
  return videoAmplifier
}

const isMuted = ref(false)

const volume = ref(parseFloat(localStorage.getItem('player_volume') ?? 100))

const convertVolume = (volume) => {
  if (volume <= 100) return volume
  return 100 + (volume - 100) * 2
}

const setVolume = () => {
  if (!videoRef.value) return

  if (Math.round(volume.value) === 0) {
    videoRef.value.muted = true
    localStorage.setItem('player_volume', volume.value)
    syncMuteState()
    return
  }

  videoRef.value.muted = false

  if (volume.value <= 100 && !videoAmplifier) {
    // Native path: no MediaElementSource until boost is needed.
    videoRef.value.volume = Math.min(volume.value / 100, 1)
  } else {
    // Once created, keep using gain with video.volume = 1.
    const amp = ensureAmplifier()
    videoRef.value.volume = 1
    amp?.context.resume()
    amp?.amplify(convertVolume(volume.value) / 100)
  }

  localStorage.setItem('player_volume', volume.value)
  syncMuteState()
}

const volumeUp = () => {
  volume.value = Math.min(volume.value + 5, 150)
  setVolume()
  actionSnackBarRef.value?.emitSnackbar(
    'volumeUp',
    `音量： ${Math.round(convertVolume(volume.value))}%`
  )
}

const volumeDown = () => {
  volume.value = Math.max(volume.value - 5, 0)
  setVolume()
  actionSnackBarRef.value?.emitSnackbar(
    'volumeDown',
    `音量： ${Math.round(convertVolume(volume.value))}%`
  )
}

const resetVolume = () => {
  volume.value = 100
  setVolume()
  actionSnackBarRef.value?.emitSnackbar(
    'volumeUp',
    `音量： ${Math.round(convertVolume(volume.value))}%`
  )
}

const toggleMute = (showAction = false) => {
  videoRef.value.muted = !videoRef.value.muted
  videoAmplifier?.context.resume()
  syncMuteState()
  if (showAction === true) {
    actionSnackBarRef.value?.emitSnackbar(videoRef.value.muted ? 'volumeMute' : 'volumeUnmute')
  }
}

// Handle dropdown
const rateDropdownRef = ref(null)
const qualityDropdownRef = ref(null)
const shareDropdown = ref(null)
const isDropdownVisible = () =>
  rateDropdownRef.value?.classList.contains('is-visible') ||
  qualityDropdownRef.value?.classList.contains('is-visible') ||
  shareDropdown.value?.classList.contains('is-visible')

// Handle show / (auto) hide UI
// Track last activity and use a single timeout instead of clear+set on every pointermove.
let autoHideTimerId = null
let lastActivityAt = 0
let autoHideDelayMs = 1000
// Plain flag (not ref): hot path for timeupdate early-exit; keep in sync with auto-hidden class.
let controlsVisible = true
const isPlayerHidden = () => !controlsVisible

const resetAutoHideTimer = () => {
  if (autoHideTimerId) {
    clearTimeout(autoHideTimerId)
    autoHideTimerId = null
  }
}

const hideUI = () => {
  // Skip if dropdown is visible
  if (isDropdownVisible()) return

  const idleFor = Date.now() - lastActivityAt
  if (idleFor < autoHideDelayMs) {
    autoHideTimerId = setTimeout(hideUI, autoHideDelayMs - idleFor)
    return
  }

  resetAutoHideTimer()
  controlsVisible = false
  overlayVideoRef.value?.classList.add('auto-hidden')
}

const showUIAndResetAutoHideTimer = (isTouchEvent = false) => {
  lastActivityAt = Date.now()
  autoHideDelayMs = (isTouchEvent ? 2 : 1) * 1000

  const wasHidden = !controlsVisible
  controlsVisible = true
  overlayVideoRef.value?.classList.remove('auto-hidden')
  // Catch up progress bar / second-resolution currentTime after idle skip.
  if (wasHidden) syncCurrentTime()

  // Only schedule hide when no timer is already pending (pointermove no longer thrashs timers).
  if (!autoHideTimerId) {
    autoHideTimerId = setTimeout(hideUI, autoHideDelayMs)
  }
}

const handlePlayerPointerEvent = (event) => {
  const isTouchEvent = isTouch(event)

  // Set touch mode
  touchMode.value = isTouchEvent

  if (isTouchEvent && event.type === 'pointermove') return // Skip trigger move event on touch mode
  showUIAndResetAutoHideTimer(isTouchEvent)
}

// Utils
const timeToText = (time) => {
  const hours = Math.floor(time / 3600)
  const minutes = Math.floor((time % 3600) / 60)
  const seconds = Math.floor(time % 60)

  const hourValue = hours.toString().padStart(2, '0')
  const minuteValue = minutes.toString().padStart(2, '0')
  const secondValue = seconds.toString().padStart(2, '0')

  return `${hourValue}:${minuteValue}:${secondValue}`
}

// Do something with pointer event trigger
const withHandlePointerEvent = (event, callback) => {
  // Only work on main hand and left click
  if (!event.isPrimary || event.button !== 0) return

  event.preventDefault()
  handlePlayerPointerEvent(event)
  callback(event)
}

// Handle player click
const doubleClickCount = ref(0)

const doubleClickTimer = ref(null)

const resetDoubleClick = () => {
  clearTimeout(doubleClickTimer.value)
  doubleClickTimer.value = null
  doubleClickCount.value = 0
}

const handlePlayerClick = (event) => {
  // Only work on main hand and left click
  if (!event.isPrimary || event.button !== 0) return

  event.preventDefault()

  // Prevent click on icon button
  if (event.target instanceof HTMLSpanElement) return

  const isTouchEvent = isTouch(event)

  // Set touch mode
  touchMode.value = isTouchEvent

  doubleClickCount.value++
  if (doubleClickCount.value === 1) {
    // First click
    if (isTouchEvent) {
      // Get click position
      const eventX = event.clientX - event.target.getBoundingClientRect().x
      // Calculate left and right side
      const leftSideEnd = videoRef.value.clientWidth / 3
      const RightSideStart = leftSideEnd * 2

      if (eventX > leftSideEnd && eventX < RightSideStart) {
        // Center
        showUIAndResetAutoHideTimer(isTouchEvent)
        togglePlay()
      } else {
        if (isPlayerHidden()) {
          showUIAndResetAutoHideTimer(isTouchEvent)
        } else {
          hideUI()
        }
      }
    } else {
      showUIAndResetAutoHideTimer(isTouchEvent)
      togglePlay(true)
    }

    // Double click timer
    clearTimeout(doubleClickTimer.value)
    doubleClickTimer.value = setTimeout(() => {
      resetDoubleClick()
    }, 300)
  } else if (doubleClickCount.value === 2) {
    // Second click
    resetDoubleClick()

    if (isTouchEvent) {
      // Get click position
      const eventX = event.clientX - event.target.getBoundingClientRect().x

      // Click center will toggle fullscreen, left and right sides will seek time
      const leftSideEnd = videoRef.value.clientWidth / 3
      const RightSideStart = leftSideEnd * 2
      if (eventX < leftSideEnd) {
        seekBackward()
      } else if (eventX > RightSideStart) {
        seekForward()
      } else {
        toggleFullscreen()
        togglePlay()
      }
    } else {
      toggleFullscreen()
      togglePlay(true)
    }
    hideUI()
  }
}

// Handle key event
const handleKeyDown = (event) => {
  // Skip if input is focused or video is not ready
  const shouldSkip =
    document.activeElement instanceof HTMLInputElement &&
    !document.activeElement.classList.contains('player-slider')
  if (shouldSkip || !videoRef.value || !props.resource) {
    return
  }

  showUIAndResetAutoHideTimer()

  switch (event.key) {
    // Play-Pause
    case ' ':
      event.preventDefault()
      togglePlay(true)
      break
    // Seek
    case 'ArrowRight':
      event.preventDefault()
      seekForward()
      break
    case 'ArrowLeft':
      event.preventDefault()
      seekBackward()
      break
    // Volume
    case 'ArrowUp':
      event.preventDefault()
      volumeUp()
      break
    case 'ArrowDown':
      event.preventDefault()
      volumeDown()
      break
    case 'M':
    case 'm':
      event.preventDefault()
      toggleMute(true)
      break
  }
}

const handleVolumeMouseWheel = (event) => {
  event.preventDefault()
  handlePlayerPointerEvent(event)

  if (event.deltaY > 0) {
    // Scroll down
    volumeDown()
  } else {
    // Scroll up
    volumeUp()
  }
}

watch(
  () => props.time,
  () => {
    restoreTime()
  }
)

onMounted(() => {
  document.addEventListener('keydown', handleKeyDown)
  document.addEventListener('fullscreenchange', syncFullscreen)
  if (isNaN(volume.value)) {
    resetVolume()
  }
  setVolume()
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeyDown)
  document.removeEventListener('fullscreenchange', syncFullscreen)
  if (videoAmplifier) {
    videoAmplifier.context.close().catch(() => {})
    videoAmplifier = null
  }
})
</script>

<template>
  <div
    id="playerContainer"
    ref="overlayVideoRef"
    class="has-full-size"
    @pointermove="handlePlayerPointerEvent"
  >
    <video
      id="mediaPlayer"
      ref="videoRef"
      crossorigin="anonymous"
      @timeupdate="syncCurrentTime"
      @seeking="syncCurrentTime"
      @durationchange="syncDuration"
      @play="syncPlayState"
      @pause="syncPlayState"
      @volumechange="syncMuteState"
      @ratechange="syncPlaybackRate"
      @pointerup="handlePlayerClick"
      @loadstart="isBuffering = true"
      @loadeddata="handlePlayerLoaded"
      @waiting="isBuffering = true"
      @playing="handlePlayerPlaying"
      @error="handlePlayerError"
      class="has-full-size"
      :src="resource?.isLive ? undefined : resource?.src"
    />

    <ErrorBlankSlate v-if="isError || isVideoError" style="position: absolute" />
    <ActionSnackbar ref="actionSnackBarRef" />
    <div v-if="isBuffering || !resource" class="ts-mask" @pointerup="handlePlayerClick">
      <div class="ts-center">
        <div class="ts-loading is-large" style="color: #fff"></div>
      </div>
    </div>
    <div
      v-if="resource && touchMode"
      id="mobileCenterControl"
      class="is-hidable has-flex-center"
    >
      <button
        class="button-touch has-flex-center"
        @pointerup="withHandlePointerEvent($event, togglePlay)"
      >
        <span v-if="isPaused" class="ts-icon is-huge tablet+:is-heading is-play-icon" />
        <span v-else class="ts-icon is-huge tablet+:is-heading is-pause-icon" />
      </button>
    </div>
    <div
      v-if="resource"
      class="ts-mask is-faded is-top is-hidable"
      @pointerup="handlePlayerPointerEvent"
    >
      <div class="ts-content" style="color: #fff">
        <div class="is-flex justify-between has-horizontally-padded">
          <div id="videoTitle">
            <div class="ts-header is-truncated">{{ resource.streamer }}</div>
            <span v-if="resource.isLive">
              <span class="ts-icon is-circle-icon" :style="{ color: '#ff4141' }" />
              Live
            </span>
            <span v-else>
              {{
                `${resource.publishTime.toLocaleDateString()} ${resource.publishTime.toLocaleTimeString()}`
              }}
            </span>
          </div>
          <div class="is-flex has-smaller-gap">
            <div>
              <button
                class="button has-flex-center"
                data-dropdown="share"
                @pointerup="handlePlayerPointerEvent"
              >
                <span class="ts-icon is-share-nodes-icon" />
              </button>
              <div
                ref="shareDropdown"
                class="ts-dropdown style-text"
                data-name="share"
                data-position="bottom-end"
              >
                <button class="item" @click="$emit('copy-link')">複製影片連結</button>
                <button
                  v-if="!resource.isLive"
                  class="item"
                  @click="$emit('copy-time-link', currentTime)"
                >
                  複製目前時間的連結
                  <span class="description">{{ timeToText(currentTime) }}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div
      v-if="resource"
      class="ts-mask is-faded is-bottom is-hidable"
      @pointerup="handlePlayerPointerEvent"
    >
      <div class="ts-content" style="color: #fff">
        <input
          v-if="!touchMode"
          ref="progressRangeDesktopRef"
          type="range"
          class="has-full-width has-cursor-pointer player-slider"
          :max="duration"
          step="any"
          value="0"
          @input="handleSeekInput"
        />
        <div class="is-flex justify-between" :class="{ 'has-horizontally-padded': !touchMode }">
          <div class="is-flex">
            <button
              v-if="!touchMode"
              class="button has-flex-center"
              @pointerup="withHandlePointerEvent($event, togglePlay)"
            >
              <span v-if="isPaused" class="ts-icon tablet+:is-big is-play-icon" />
              <span v-else class="ts-icon tablet+:is-big is-pause-icon" />
            </button>
            <VolumeControl
              v-if="!touchMode"
              v-model:volume="volume"
              :is-muted="isMuted"
              :convert-volume="convertVolume"
              @reset-button-pointerup="withHandlePointerEvent($event, resetVolume)"
              @mute-button-pointerup="withHandlePointerEvent($event, toggleMute)"
              @volume-mousewheel="handleVolumeMouseWheel"
              @pointerup="handlePlayerPointerEvent"
              @update:volume="setVolume"
            />
            <span>
              <span ref="timeTextRef">00:00:00</span>
              <span v-if="!isNaN(duration)"> / {{ durationText }} </span>
            </span>
          </div>
          <div class="is-flex">
            <VolumeControl
              v-if="touchMode"
              v-model:volume="volume"
              :is-muted="isMuted"
              :convert-volume="convertVolume"
              @reset-button-pointerup="withHandlePointerEvent($event, resetVolume)"
              @mute-button-pointerup="withHandlePointerEvent($event, toggleMute)"
              @volume-mousewheel="handleVolumeMouseWheel"
              @pointerup="handlePlayerPointerEvent"
              @update:volume="setVolume"
            />
            <div v-if="qualityList.length > 1">
              <button
                class="button has-flex-center"
                data-dropdown="quality"
                @pointerup="handlePlayerPointerEvent"
              >
                <span class="ts-icon tablet+:is-big is-images-icon" />
              </button>
              <div
                ref="qualityDropdownRef"
                class="ts-dropdown style-text"
                data-name="quality"
                data-position="top-end"
              >
                <button
                  class="item"
                  :class="{ 'is-selected': currentQuality === -1 }"
                  @click="$emit('change-quality', -1)"
                >
                  Auto
                </button>

                <button
                  v-for="(quality, index) in qualityList"
                  :key="`quality-${index}`"
                  class="item"
                  :class="{ 'is-selected': currentQuality === index }"
                  @click="$emit('change-quality', index)"
                >
                  {{ quality }}
                </button>
              </div>
            </div>
            <div>
              <button
                class="button has-flex-center"
                data-dropdown="speed"
                @pointerup="handlePlayerPointerEvent"
              >
                <span class="ts-icon tablet+:is-big is-gauge-simple-high-icon" />
              </button>
              <div
                ref="rateDropdownRef"
                class="ts-dropdown style-text"
                data-name="speed"
                data-position="top-end"
              >
                <button
                  v-for="rateItem in playbackRateList"
                  :key="rateItem.value"
                  class="item"
                  :class="{ 'is-selected': rateItem.value === playbackRate }"
                  @click="setPlaybackRate(rateItem.value)"
                >
                  {{ rateItem.text }}
                </button>
              </div>
            </div>
            <button
              class="button has-flex-center"
              @pointerup="withHandlePointerEvent($event, toggleFullscreen)"
            >
              <span v-if="isFullscreen" class="ts-icon is-compress-icon" />
              <span v-else class="ts-icon tablet+:is-big is-expand-icon" />
            </button>
          </div>
        </div>
        <input
          v-if="touchMode"
          ref="progressRangeTouchRef"
          type="range"
          class="has-full-width has-cursor-pointer player-slider"
          :max="duration"
          step="any"
          value="0"
          @input="handleSeekInput"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Auto Hide */
.is-hidable {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition-property: opacity, visibility;
  transition-duration: 200ms;
}

.ts-mask.is-faded.is-top {
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.9) 0, rgba(0, 0, 0, 0.1) 90%, transparent);
}

.ts-mask.is-faded.is-bottom {
  background: linear-gradient(0deg, rgba(0, 0, 0, 0.9) 0, rgba(0, 0, 0, 0.1) 90%, transparent);
}

#playerContainer:not(.auto-hidden) > .is-hidable {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
}

.auto-hidden,
.auto-hidden * {
  cursor: none;
}

#videoTitle {
  max-width: 80%;
}

/* Workaround tocas-ui's important */
.auto-hidden .has-cursor-pointer {
  cursor: none !important;
}

/* Elements */
.button {
  width: 30px;
  height: 30px;
}

.button-touch {
  width: 36px;
  height: 36px;
}

@media (min-width: 768px) {
  .button-touch {
    width: 90px;
    height: 90px;
  }
}

#playerContainer {
  display: inline-flex;
}

#mediaPlayer {
  /* Isolate video on its own compositor layer so chrome repaints hurt less on Firefox. */
  transform: translateZ(0);
}

#playerContainer:not(:fullscreen) video {
  aspect-ratio: 16/9;
  max-height: 80vh;
  display: inline-flex;
  box-sizing: content-box;
}

#mobileCenterControl {
  color: #fff;
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
}

#mobileCenterControl .ts-icon::before {
  text-shadow: #000 2px 2px 5px;
}

/* Util Styles */
.is-flex {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.justify-between {
  justify-content: space-between;
}

.style-text {
  color: var(--ts-gray-900);
}
</style>
