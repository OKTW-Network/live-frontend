<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { debounce } from 'lodash'

import VolumeControl from './OverlayPlayer/VolumeControl.vue'
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
  isError: {
    type: Boolean,
    default: false
  }
})
defineEmits(['change-quality'])

// Handle touch mode
const touchMode = ref(false)
const isTouch = (event) => event?.pointerType === 'touch'

// Handle video element
const videoRef = ref(null)

const overlayVideoRef = ref(null)

const isVideoError = ref(false)

const isBuffering = ref(false)

const isPaused = ref(true)

const isFullscreen = ref(false)

const currentTime = ref(0)

const timeText = computed(() => timeToText(currentTime.value))

const draggingCurrentTime = ref(undefined)

const duration = ref(0)

const durationText = computed(() => timeToText(duration.value))

const playbackRate = ref(1)

const updatePlayerStatus = () => {
  isBuffering.value = false
  currentTime.value = draggingCurrentTime.value ?? videoRef.value?.currentTime
  duration.value = videoRef.value?.duration
  isPaused.value = videoRef.value?.paused
  isMuted.value = videoRef.value?.muted
  volume.value = videoRef.value?.muted
    ? 0
    : reverseVolume(videoAmplifier.value?.getAmpLevel() * 100)
  isFullscreen.value = document.fullscreenElement !== null
  playbackRate.value = videoRef.value?.playbackRate
}

const handlePlayerLoaded = () => {
  updatePlayerStatus()
  showUIAndResetAutoHideTimer()
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
  updatePlayerStatus()
}

const debounceSeekDrag = () => {
  draggingCurrentTime.value = currentTime.value
  debounce(setTime, 500)()
}

const setTime = () => {
  draggingCurrentTime.value = undefined
  videoRef.value.currentTime = currentTime.value
  updatePlayerStatus()
}

const seekForward = () => {
  currentTime.value = Math.min(currentTime.value + 5, duration.value)
  setTime()
}

const seekBackward = () => {
  currentTime.value = Math.max(currentTime.value - 5, 0)
  setTime()
}

const togglePlay = () => {
  if (!props.resource) return
  if (videoRef.value.paused) {
    videoRef.value.play()
  } else {
    videoRef.value.pause()
  }
  updatePlayerStatus()
}

const toggleFullscreen = () => {
  if (!props.resource) return
  if (!document.fullscreenElement) {
    overlayVideoRef.value?.requestFullscreen().catch((err) => {
      console.error(`Error attempting to enable fullscreen mode: ${err.message} (${err.name})`)
    })
  } else {
    document.exitFullscreen()
  }
}

const setBufferAndErrorState = (buffering, error) => {
  isBuffering.value = buffering
  isVideoError.value = error
}

// Handle video volume
const videoAmplifier = computed(() => {
  if (!videoRef.value) return null
  const context = new (window.AudioContext || window.webkitAudioContext)(),
    result = {
      context: context,
      source: context.createMediaElementSource(videoRef.value),
      gain: context.createGain(),
      media: videoRef.value,
      amplify: function (multiplier) {
        result.gain.gain.value = multiplier
      },
      getAmpLevel: function () {
        return result.gain.gain.value
      }
    }
  result.source.connect(result.gain)
  result.gain.connect(context.destination)
  result.amplify(1)
  return result
})

const isMuted = ref(false)

const volume = ref(100)

const convertVolume = (volume) => {
  if (volume <= 100) return volume
  return 100 + (volume - 100) * 2
}

const reverseVolume = (volume) => {
  if (volume <= 100) return volume
  return 100 + (volume - 100) / 2
}

const setVolume = () => {
  if (volume.value === 0) {
    videoRef.value.muted = true
    updatePlayerStatus()
    return
  }

  videoRef.value.muted = false
  videoAmplifier.value?.amplify(convertVolume(volume.value) / 100)
  updatePlayerStatus()
}

const volumeUp = () => {
  volume.value = Math.min(volume.value + 5, 150)
  setVolume()
}

const volumeDown = () => {
  volume.value = Math.max(volume.value - 5, 0)
  setVolume()
}

const resetVolume = () => {
  volume.value = 100
  setVolume()
}

const toggleMute = () => {
  videoRef.value.muted = !videoRef.value.muted
  updatePlayerStatus()
}

// Handle dropdown
const rateDropdownRef = ref(null)
const qualityDropdownRef = ref(null)
const isDropdownVisible = () =>
  rateDropdownRef.value?.classList.contains('is-visible') ||
  qualityDropdownRef.value?.classList.contains('is-visible')

// Handle show / (auto) hide UI
const autoHideTimer = ref(null)
const isPlayerHidden = () => overlayVideoRef.value?.classList.contains('auto-hidden') ?? false

const resetAutoHideTimer = () => {
  if (autoHideTimer.value) {
    clearTimeout(autoHideTimer.value)
    autoHideTimer.value = null
  }
}

const hideUI = () => {
  // Skip if dropdown is visible
  if (isDropdownVisible()) return

  resetAutoHideTimer()

  overlayVideoRef.value?.classList.add('auto-hidden')
}

const showUIAndResetAutoHideTimer = (isTouchEvent = false) => {
  resetAutoHideTimer()

  // set timeout to wait of idle time
  const t = setTimeout(hideUI, (isTouchEvent ? 2 : 1) * 1000)
  autoHideTimer.value = t

  overlayVideoRef.value?.classList.remove('auto-hidden')
}

const handlePlayerPointerEvent = (event) => {
  const isTouchEvent = isTouch(event)

  // Set touch mode
  touchMode.value = isTouchEvent

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
const isFirstClickUIHidden = ref(false)

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

  const isHidden = isPlayerHidden()
  const isTouchEvent = isTouch(event)

  // Set touch mode
  touchMode.value = isTouchEvent

  doubleClickCount.value++
  if (doubleClickCount.value === 1) {
    // Trigger first click
    handlePlayerFirstClick(event, isHidden, isTouchEvent)
  } else if (doubleClickCount.value === 2) {
    // Reset timer and count
    resetDoubleClick()
    // Trigger second click
    handlePlayerSecondClick(event, isTouchEvent)
  }
}

const handlePlayerFirstClick = (event, isHidden, isTouchEvent) => {
  // Store first click UI hidden status
  isFirstClickUIHidden.value = isHidden

  if (!isTouchEvent) {
    // Toggle play when dropdown is not visible
    if (!isDropdownVisible()) {
      showUIAndResetAutoHideTimer(isTouchEvent)
      togglePlay()
    }
  } else if (isHidden) {
    showUIAndResetAutoHideTimer(isTouchEvent)
  }

  // Delay 300 to detect double click and hide UI on touch
  doubleClickTimer.value = setTimeout(() => {
    resetDoubleClick()
    if (isTouchEvent && !isHidden) {
      hideUI()
    }
  }, 300)
}

const handlePlayerSecondClick = (event, isTouchEvent) => {
  // Skip if video is not ready or dropdown is visible
  if (!videoRef.value || isDropdownVisible()) {
    return
  }

  if (isTouchEvent && !isFirstClickUIHidden.value) {
    // Trigger show UI to reset auto hide timer
    showUIAndResetAutoHideTimer(isTouchEvent)

    // Get click position
    const elementOffsetX = event.target.getBoundingClientRect().x
    const eventX = event.clientX - elementOffsetX

    // Click center will toggle play, left and right sides will seek time
    const leftSideEnd = videoRef.value.clientWidth / 3
    const RightSideStart = leftSideEnd * 2
    if (eventX < leftSideEnd) {
      seekBackward()
    } else if (eventX > RightSideStart) {
      seekForward()
    } else {
      togglePlay()
    }
  } else {
    toggleFullscreen()

    if (isTouchEvent) {
      hideUI()
    } else {
      showUIAndResetAutoHideTimer(isTouchEvent)
      togglePlay()
    }
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
      togglePlay()
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
      toggleMute()
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

onMounted(() => {
  document.addEventListener('keydown', handleKeyDown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeyDown)
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
      @timeupdate="updatePlayerStatus"
      @seeking="updatePlayerStatus"
      @pointerup="handlePlayerClick"
      @loadstart="isBuffering = true"
      @loadeddata="handlePlayerLoaded"
      @waiting="isBuffering = true"
      @playing="setBufferAndErrorState(false, false)"
      @error="setBufferAndErrorState(false, true)"
      class="has-full-size"
      :src="resource?.isLive ? undefined : resource?.src"
      autoplay
    />

    <ErrorBlankSlate v-if="isError || isVideoError" style="position: absolute" />
    <div v-if="isBuffering || !resource" class="ts-mask" @pointerup="handlePlayerClick">
      <div class="ts-center">
        <div class="ts-loading is-large" style="color: #fff"></div>
      </div>
    </div>
    <div
      v-if="resource && touchMode"
      id="mobileCenterControl"
      class="is-hidable has-flex-center has-horizontally-padded-huge"
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
    </div>
    <div
      v-if="resource"
      class="ts-mask is-faded is-bottom is-hidable"
      @pointerup="handlePlayerPointerEvent"
    >
      <div class="ts-content" style="color: #fff">
        <input
          v-if="!touchMode"
          type="range"
          class="has-full-width has-cursor-pointer player-slider"
          v-model="currentTime"
          :max="duration"
          step="any"
          @input="debounceSeekDrag"
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
              {{ timeText }}
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
          type="range"
          class="has-full-width has-cursor-pointer player-slider"
          v-model="currentTime"
          :max="duration"
          step="any"
          @input="debounceSeekDrag"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Auto Hide */
.is-hidable {
  opacity: 0;
  transition-duration: 500ms;
}

.ts-mask.is-faded.is-top {
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.9) 0, rgba(0, 0, 0, 0.1) 90%, transparent);
}

.ts-mask.is-faded.is-bottom {
  background: linear-gradient(0deg, rgba(0, 0, 0, 0.9) 0, rgba(0, 0, 0, 0.1) 90%, transparent);
}

#playerContainer:not(.auto-hidden) > .is-hidable {
  opacity: 1;
}

.auto-hidden,
.auto-hidden * {
  cursor: none;
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
