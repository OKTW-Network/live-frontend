<script setup>
import { computed } from 'vue'
import LivePlayer from './LivePlayer.vue'
import OverlayPlayer from './OverlayPlayer.vue'

const props = defineProps({
  filename: String,
  list: Array
})

const resource = computed(() => props.list?.filter((i) => i.name === props.filename)[0])
</script>

<template>
  <LivePlayer v-if="resource?.isLive" :resource="resource" />
  <OverlayPlayer v-else :resource="resource" />
</template>
