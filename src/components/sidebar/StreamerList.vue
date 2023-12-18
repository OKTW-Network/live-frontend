<script setup>
defineProps({
  path: String,
  livestreamList: Array
})
</script>

<template>
  <div class="ts-menu is-start-icon is-separated has-full-width">
    <a class="item" href="#">
      <span class="ts-icon is-house-icon"></span>
      <span class="ts-text is-truncated has-leading-small">Home Page</span>
    </a>
    <div class="ts-divider"></div>
    <a
      class="item"
      v-for:="i in livestreamList"
      :href="`#profile/${i.streamer}`"
      :class="{ 'is-active': path.split('/').at(1) === i.streamer }"
    >
      <span v-if="i.isLive" class="ts-icon is-video-icon is-negative"></span>
      <span v-else class="ts-icon is-video-icon"></span>
      <span class="ts-text is-truncated has-leading-small">{{ i.streamer }}</span>
    </a>
  </div>
</template>

<style scoped>
.item .ts-icon {
  flex-shrink: 0;
}
</style>
