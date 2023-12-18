<script setup>
import { computed } from 'vue'
import LivePlayer from './LivePlayer.vue'
import OverlayPlayer from './OverlayPlayer.vue'

const props = defineProps({
  currentPath: String,
  list: Array
})

const resource = computed(
  () => props.list?.filter((i) => i.name == props.currentPath?.split('/').at(-1))[0]
)
</script>

<template>
  <LivePlayer v-if="resource?.isLive" :resource="resource" />
  <OverlayPlayer v-else :resource="resource" />
</template>
