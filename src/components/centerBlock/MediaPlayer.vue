<script setup>
import { computed } from 'vue'
import LivePlayer from './LivePlayer.vue'
import OverlayPlayer from './OverlayPlayer.vue'

const props = defineProps({
  filename: String,
  list: Array,
  time: {
    type: String,
    required: false,
    default: undefined
  },
  watchTogetherCode: {
    type: String,
    required: false,
    default: undefined
  }
})
defineEmits(['copy-link', 'copy-time-link', 'copy-watch-together-link', 'start-new-watch-together'])

const resource = computed(() => props.list?.filter((i) => i.name === props.filename)[0])
</script>

<template>
  <LivePlayer v-if="resource?.isLive" :resource="resource" @copy-link="$emit('copy-link')" />
  <OverlayPlayer
    v-else
    :resource="resource"
    :time="time"
    :watch-together-code="watchTogetherCode"
    @copy-link="$emit('copy-link')"
    @copy-time-link="$emit('copy-time-link', $event)"
    @copy-watch-together-link="$emit('copy-watch-together-link')"
    @start-new-watch-together="$emit('start-new-watch-together')"
  />
</template>
