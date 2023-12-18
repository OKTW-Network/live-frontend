<script setup>
import { ref, onBeforeUnmount, onMounted, watch } from 'vue'
import OverlayPlayer from './OverlayPlayer.vue'

const props = defineProps({
  resource: Object
})

const hls = ref(null)
const player = ref(null)
const isError = ref(false)

const qualityList = ref([])
const currentQuality = ref(-1)

const change_quality = (quality) => {
  if (qualityList.value.length > quality) {
    currentQuality.value = quality
    localStorage.setItem('config_quality', currentQuality.value)
  }
  hls.value.nextLevel = currentQuality.value
}

const initHls = () => {
  if (props.resource?.isLive && Hls.isSupported()) {
    hls.value = new Hls({
      liveSyncDurationCount: 0,
      fetchSetup: (context) => new Request(context.url)
    })
    hls.value.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal) {
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            // try to recover network error
            console.error('fatal network error encountered, try to recover')
            hls.value.startLoad()
            break
          case Hls.ErrorTypes.MEDIA_ERROR:
            console.error('fatal media error encountered, try to recover')
            hls.value.recoverMediaError()
            break
          default:
            // cannot recover
            console.error('fatal error encountered, could not recover')
            isError.value = true
            hls.value.destroy()
            break
        }
      } else if (data.details === Hls.ErrorDetails.INTERNAL_EXCEPTION) {
        console.error('internal error encountered, counting as unrecoverable error')
        isError.value = true
        hls.value.destroy()
      }
    })
    hls.value.loadSource(props.resource?.src)
    hls.value.attachMedia(player.value)
    hls.value.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
      const play = player.value.play()
      qualityList.value = data.levels.map((i) =>
        i.height ? `${i.height}p (${i.bitrate / 1000}kbps)` : 'Source'
      )

      const stored_quality = localStorage.getItem('config_quality')
      change_quality(
        stored_quality !== null && !isNaN(parseInt(stored_quality)) ? parseInt(stored_quality) : -1
      )

      if (play)
        play.catch((error) => {
          if (error.name === 'NotAllowedError') {
            player.value.muted = true
            player.value.play()
          }
        })
    })

    // Workaround firefox codec test fail
    let origListener = hls.value.listeners(Hls.Events.BUFFER_CODECS)
    hls.value.removeAllListeners([Hls.Events.BUFFER_CODECS])
    hls.value.on(Hls.Events.BUFFER_CODECS, (event, data) => {
      if (
        data.video &&
        data.video.container === 'video/mp4' &&
        data.video.codec &&
        !MediaSource.isTypeSupported(`${data.video.container};codecs=${data.video.codec}`)
      ) {
        data.video.codec = 'avc1.640034' // Override level to 5.2
      }
    })
    origListener.forEach((f) => hls.value.on(Hls.Events.BUFFER_CODECS, f))
  }
  // Fuck you apple
  else if (player.value.canPlayType('application/vnd.apple.mpegurl')) {
    player.value.src = props.resource?.src
    player.value.addEventListener('loadedmetadata', () => player.value.play())
  }
}

onMounted(() => {
  player.value = document.getElementById('mediaPlayer')

  initHls()
})

watch(
  () => props.resource?.streamer,
  () => {
    hls.value?.destroy()
    setTimeout(() => initHls(), 100)
  }
)
onBeforeUnmount(() => {
  hls.value?.destroy()
})
</script>

<template>
  <OverlayPlayer
    :resource="resource"
    :quality-list="qualityList"
    :current-quality="currentQuality"
    :is-error="isError"
    @change-quality="change_quality"
  />
</template>
