<script setup>
import { ref, computed } from 'vue'

const types = {
  play: {
    icon: 'play',
    text: '播放'
  },
  pause: {
    icon: 'pause',
    text: '暂停'
  },
  forward: {
    icon: 'forward',
    text: '+5s',
    additionalClass: 'is-forward'
  },
  backward: {
    icon: 'backward',
    text: '-5s',
    additionalClass: 'is-backward'
  },
  volumeUp: {
    icon: 'volume-high',
    text: ''
  },
  volumeDown: {
    icon: 'volume-low',
    text: ''
  },
  volumeMute: {
    icon: 'volume-xmark',
    text: '靜音'
  },
  volumeUnmute: {
    icon: 'volume-high',
    text: '取消靜音'
  },
  volumeUnavailable: {
    icon: 'volume-xmark',
    text: '缺少媒體自動播放權限，已預設靜音',
    overrideTimeout: 3000
  }
}
const actionType = ref('play')
const customText = ref(undefined)
const snackBarTimeout = ref(null)
const isSnackBarHidden = ref(true)
const text = computed(() => customText.value ?? types[actionType.value].text)
const icon = computed(() => types[actionType.value].icon)
const additionalClass = computed(() => types[actionType.value].additionalClass ?? '')

const emitSnackbar = (type, text = undefined) => {
  if (snackBarTimeout.value) {
    clearTimeout(snackBarTimeout.value)
    snackBarTimeout.value = null
  }

  const timeout = setTimeout(() => {
    snackBarTimeout.value = null
    isSnackBarHidden.value = true
    customText.value = undefined
  }, types[type].overrideTimeout ?? 1000)
  snackBarTimeout.value = timeout

  if (text && text.trim() !== '') customText.value = text
  actionType.value = type
  isSnackBarHidden.value = false
}

defineExpose({ emitSnackbar })
</script>

<template>
  <div id="actionSnackBar" class="has-pointer-events-none" :class="[additionalClass, { 'has-hidden': isSnackBarHidden }]">
    <div class="ts-snackbar">
      <div class="content">
        <span class="ts-icon" :class="[`is-${icon}-icon`]" />
        {{ text }}
      </div>
    </div>
  </div>
</template>

<style scoped>
#actionSnackBar {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  opacity: 0.8;
}

#actionSnackBar.is-forward {
  left: 75%;
}

#actionSnackBar.is-backward {
  left: 25%;
}

#actionSnackBar .ts-snackbar {
  transition-duration: 500ms;
}

.ts-snackbar .content {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}
</style>
