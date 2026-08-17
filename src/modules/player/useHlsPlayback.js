import { onBeforeUnmount, ref, watch } from 'vue'
import Hls from 'hls.js/dist/hls.light.mjs'

const HLS_MIME_TYPE = 'application/vnd.apple.mpegurl'

export const useHlsPlayback = (videoRef, mediaRef) => {
  const hls = ref(null)
  const isError = ref(false)
  const qualityList = ref([])
  const currentQuality = ref(-1)

  let nativeLoadedMetadataHandler = null

  const changeQuality = (quality) => {
    if (!hls.value) return

    if (qualityList.value.length > quality) {
      currentQuality.value = quality
      localStorage.setItem('config_quality', currentQuality.value)
    }
    hls.value.nextLevel = currentQuality.value
  }

  const destroyHls = () => {
    const video = videoRef.value
    if (video && nativeLoadedMetadataHandler) {
      video.removeEventListener('loadedmetadata', nativeLoadedMetadataHandler)
    }
    nativeLoadedMetadataHandler = null

    hls.value?.destroy()
    hls.value = null
    qualityList.value = []
    currentQuality.value = -1
  }

  const initHls = () => {
    const video = videoRef.value
    const media = mediaRef.value
    if (!video || media?.kind !== 'live') return

    isError.value = false

    if (Hls.isSupported()) {
      const engine = new Hls({
        liveSyncDurationCount: 0,
        fetchSetup: (context) => new Request(context.url)
      })
      hls.value = engine

      engine.on(Hls.Events.ERROR, (event, data) => {
        if (hls.value !== engine) return

        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              console.error('fatal network error encountered, try to recover')
              engine.startLoad()
              break
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.error('fatal media error encountered, try to recover')
              engine.recoverMediaError()
              break
            default:
              console.error('fatal error encountered, could not recover')
              isError.value = true
              engine.destroy()
              if (hls.value === engine) hls.value = null
              break
          }
        } else if (data.details === Hls.ErrorDetails.INTERNAL_EXCEPTION) {
          console.error('internal error encountered, counting as unrecoverable error')
          isError.value = true
          engine.destroy()
          if (hls.value === engine) hls.value = null
        }
      })

      engine.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
        if (hls.value !== engine) return

        qualityList.value = data.levels.map((level) =>
          level.height ? `${level.height}p (${level.bitrate / 1000}kbps)` : 'Source'
        )

        const storedQuality = localStorage.getItem('config_quality')
        changeQuality(
          storedQuality !== null && !isNaN(parseInt(storedQuality, 10))
            ? parseInt(storedQuality, 10)
            : -1
        )
      })

      engine.loadSource(media.src)
      engine.attachMedia(video)
      return
    }

    if (video.canPlayType(HLS_MIME_TYPE)) {
      video.src = media.src
      nativeLoadedMetadataHandler = () => video.play()
      video.addEventListener('loadedmetadata', nativeLoadedMetadataHandler)
    }
  }

  watch(
    [videoRef, () => mediaRef.value?.src, () => mediaRef.value?.kind],
    ([video, source, kind]) => {
      destroyHls()
      isError.value = false
      if (video && source && kind === 'live') initHls()
    },
    { immediate: true, flush: 'post' }
  )

  onBeforeUnmount(destroyHls)

  return {
    changeQuality,
    currentQuality,
    isError,
    qualityList
  }
}
