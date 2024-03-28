export function initHLS(resource, player) {
  if (resource?.isLive && Hls.isSupported()) {
    let hls
    let qualityList

    hls = new Hls({
      liveSyncDurationCount: 0,
      fetchSetup: (context) => new Request(context.url)
    })
    hls.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal) {
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            // try to recover network error
            console.error('fatal network error encountered, try to recover')
            hls.startLoad()
            break
          case Hls.ErrorTypes.MEDIA_ERROR:
            console.error('fatal media error encountered, try to recover')
            hls.recoverMediaError()
            break
          default:
            // cannot recover
            console.error('fatal error encountered, could not recover')
            hls.destroy()
            throw new Error('fatal error encountered, could not recover')
        }
      } else if (data.details === Hls.ErrorDetails.INTERNAL_EXCEPTION) {
        console.error('internal error encountered, counting as unrecoverable error')
        hls.destroy()
        throw new Error('internal error encountered, counting as unrecoverable error')
      }
    })
    hls.loadSource(resource?.src)
    hls.attachMedia(player)
    hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
      qualityList.value = data.levels.map((i) =>
        i.height ? `${i.height}p (${i.bitrate / 1000}kbps)` : 'Source'
      )

      const stored_quality = localStorage.getItem('config_quality')
      change_quality(
        stored_quality !== null && !isNaN(parseInt(stored_quality)) ? parseInt(stored_quality) : -1
      )
    })

    // Workaround firefox codec test fail
    let origListener = hls.listeners(Hls.Events.BUFFER_CODECS)
    hls.removeAllListeners([Hls.Events.BUFFER_CODECS])
    hls.on(Hls.Events.BUFFER_CODECS, (event, data) => {
      if (
        data.video &&
        data.video.container === 'video/mp4' &&
        data.video.codec &&
        !MediaSource.isTypeSupported(`${data.video.container};codecs=${data.video.codec}`)
      ) {
        data.video.codec = 'avc1.640034' // Override level to 5.2
      }
    })
    origListener.forEach((f) => hls.on(Hls.Events.BUFFER_CODECS, f))
  }
  // Fuck you apple
  else if (player.value.canPlayType('application/vnd.apple.mpegurl')) {
    player.value.src = resource?.src
    player.value.addEventListener('loadedmetadata', () => player.value.play())
  }
}
