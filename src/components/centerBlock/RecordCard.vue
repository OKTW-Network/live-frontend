<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  streamer: String,
  publishTime: Date,
  duration: String,
  src: String,
  name: String,
  isLive: Boolean
})
const pubTime = computed(
  () => `${props.publishTime.toLocaleDateString()} ${props.publishTime.toLocaleTimeString()}`
)
const parsedu = computed(() => {
  let h = Math.floor(props.duration / 3600)
  let m = Math.floor((props.duration % 3600) / 60)
  let s = Math.floor(props.duration % 60)
  if (h < 10) h = `0${h}`
  if (m < 10) m = `0${m}`
  if (s < 10) s = `0${s}`
  return `${h}:${m}:${s}`
})
const isload = ref(false)
</script>

<template>
  <!-- Box -->
  <a class="ts-box" :href="`#profile/${streamer}/${name}`">
    <!-- Preview image -->
    <div class="live-card-picture ts-image" :class="{ 'live-loading': !isload }">
      <picture>
        <source v-if="isLive" type="image/jxl" :srcset="`${src.substring(0, src.length - 4)}jxl`" />
        <source v-else type="image/jxl" :srcset="`${src.substring(0, src.length - 3)}jxl`" />
        <source
          v-if="isLive"
          type="image/avif"
          :srcset="`${src.substring(0, src.length - 4)}avif`"
        />
        <source v-else type="image/avif" :srcset="`${src.substring(0, src.length - 3)}avif`" />
        <source v-if="isLive" type="image/png" :srcset="`${src.substring(0, src.length - 4)}png`" />
        <source v-else type="image/png" :srcset="`${src.substring(0, src.length - 3)}png`" />
        <img
          @load="isload++"
          src="data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 160 90' xmlns:v='https://vecta.io/nano'%3e%3cpath d='M0 0h160v90H0z' fill='%23232323'/%3e%3cg fill='%23676767'%3e%3ccircle cx='60' cy='45' r='6'/%3e%3ccircle cx='80' cy='45' r='6'/%3e%3ccircle cx='100' cy='45' r='6'/%3e%3c/g%3e%3c/svg%3e"
          alt="Record thumb"
          loading="lazy"
          onerror="this.parentNode.children[0] != this && this.parentNode.children[0].remove()"
        />
      </picture>
    </div>
    <!-- Metadata -->
    <div class="ts-content is-secondary has-full-height">
      <div class="ts-text is-description is-truncated">{{ streamer }}</div>
      <div v-if="isLive" class="ts-header is-truncated is-heavy" style="color: #ff4141">Live</div>
      <div v-else class="ts-header is-truncated is-heavy">{{ parsedu }}</div>
      <div v-if="!isLive" class="ts-text is-description">{{ pubTime }}</div>
      <div v-else class="ts-text is-description">Now</div>
    </div>
  </a>
</template>

<style scoped>
.live-card-picture {
  width: 100%;
  aspect-ratio: 16/9;
  object-fit: contain;
  display: inline-block;
}
.live-loading {
  background-image: url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 160 90' %3e%3cpath d='M0 0h160v90H0z' fill='%23232323'/%3e%3cellipse cx='60' cy='45' rx='6' ry='6' fill='red'%3e%3canimate id='A' attributeName='cy' begin='0s%3bC.end' values='45%3b47%3b40%3b47%3b45' dur='0.4s'/%3e%3canimate attributeName='ry' begin='0s%3bC.end' values='6%3b5%3b7%3b5%3b6' dur='0.4s'/%3e%3c/ellipse%3e%3cellipse cx='80' cy='45' rx='6' ry='6' fill='%230f0'%3e%3canimate id='B' attributeName='cy' begin='A.end' values='45%3b47%3b40%3b47%3b45' dur='0.4s'/%3e%3canimate attributeName='ry' begin='A.end' values='6%3b5%3b7%3b5%3b6' dur='0.4s'/%3e%3c/ellipse%3e%3cellipse cx='100' cy='45' rx='6' ry='6' fill='%2300f'%3e%3canimate id='C' attributeName='cy' begin='B.end' values='45%3b47%3b40%3b47%3b45' dur='0.4s'/%3e%3canimate attributeName='ry' begin='B.end' values='6%3b5%3b7%3b5%3b6' dur='0.4s'/%3e%3c/ellipse%3e%3c/svg%3e");
  background-repeat: no-repeat;
}

/* Prevent text growing */
.ts-text.is-truncated {
  min-width: 100%;
  width: 0;
}
</style>
