<script setup>
import { computed, ref } from 'vue'
import RecordCard from './RecordCard.vue'

const props = defineProps({
  currentPath: String,
  list: Array
})

defineEmits(['top'])

const cardAmount = ref(-40)
const playlist = computed(() => {
  const pathList = props.currentPath.split('/')
  if (pathList.length > 1) {
    return props.list?.filter((i) => i.streamer === pathList.at(1))
  } else {
    return props.list
  }
})
</script>

<template>
  <!-- Card View -->
  <!-- Grid -->
  <div
    class="ts-grid has-spaced-large mobile:is-2-columns tablet-desktop:is-3-columns widescreen:is-5-columns"
  >
    <!-- Column -->
    <RecordCard
      v-for="i in playlist?.slice(cardAmount).reverse()"
      :key="i.name"
      class="column"
      :streamer="i.streamer"
      :publishTime="i.publishTime"
      :duration="i.duration"
      :src="i.src"
      :name="i.name"
      :isLive="'isLive' in i"
    />
    <!-- Scroll top button -->
    <button class="ts-button is-start-icon is-wide is-fluid" @click="$emit('top')">
      <span class="ts-icon is-wheelchair-move-icon"></span>Top
    </button>
    <!-- Load more button -->
    <button
      v-if="playlist?.length > Math.abs(cardAmount)"
      class="ts-button is-wide is-outlined is-fluid"
      @click="cardAmount -= 40"
    >
      Load more
    </button>
    <button v-else class="ts-button is-wide is-outlined is-fluid is-disabled">No more</button>
  </div>
</template>
