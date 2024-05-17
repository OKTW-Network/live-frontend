<script setup>
import { computed } from 'vue';

const props = defineProps({
  modelOpen: {
    type: Boolean,
    default: false
  },
  isActive: {
    type: Boolean,
    default: false
  },
  isHost: {
    type: Boolean,
    default: false
  },
  hostname: {
    type: String,
    default: ''
  },
  viewerCount: {
    type: Number,
    default: 0
  },
  isLocked: {
    type: Boolean,
    default: false
  },
  nickname: {
    type: String,
    default: ''
  },
  watchTogetherCode: {
    type: String,
    required: false,
    default: undefined
  },
})

defineEmits(['nickname-change', 'lock-change', 'close', 'start-new-watch-together', 'copy-watch-together-link'])

const isWaiting = computed(() => props.watchTogetherCode !== undefined && !props.isActive)
</script>

<template>
  <div class="ts-modal" :class="{ 'is-visible': modelOpen }">
    <div class="content">
      <div class="ts-content">
        <div class="ts-grid is-middle-aligned">
          <div class="column is-fluid">
            <div class="ts-header">同時觀看</div>
          </div>
          <div class="column">
            <button class="ts-close" @click="$emit('close')"></button>
          </div>
        </div>
      </div>
      <div class="ts-divider"></div>
      <div class="ts-content">
        <div class="ts-wrap is-vertical">
          <div class="ts-control is-stacked">
            <div class="label">暱稱</div>
            <div class="content">
              <div class="ts-input">
                <input
                  type="text"
                  :value="nickname"
                  @focusout="$emit('nickname-change', $event.target.value)"
                />
              </div>
            </div>
          </div>
          <div v-if="!isActive && !isWaiting" class="ts-iconset">
            <span class="ts-icon is-tower-broadcast-icon" style="color: var(--ts-negative-500)" />
            <div class="content">
              <div class="title">共同觀看未執行</div>
              <div class="text">按下啟動以開始</div>
            </div>
          </div>
          <div v-if="isWaiting" class="ts-iconset">
            <span class="ts-icon is-tower-broadcast-icon" style="color: var(--ts-warning-500)" />
            <div class="content">
              <div class="title">連線中...</div>
              <div class="text">請稍後</div>
            </div>
          </div>
          <div v-if="isActive" class="status-grid">
            <div class="ts-iconset">
              <span
                class="ts-icon is-tower-broadcast-icon"
                :style="{ color: isHost ? 'var(--ts-negative-500)' : 'var(--ts-positive-500)' }"
              />
              <div class="content">
                <div class="title">主持人</div>
                <div class="text">{{ isHost ? '您' : hostname }}</div>
              </div>
            </div>
            <div class="ts-iconset">
              <span class="ts-icon is-eye-icon" />
              <div class="content">
                <div class="title">觀看人數</div>
                <div class="text">{{ viewerCount }}</div>
              </div>
            </div>
          </div>
          <label class="ts-switch" :class="{ 'is-disabled': isActive && !isHost }">
            <input
              type="checkbox"
              :disabled="isActive && !isHost"
              :checked="!isLocked"
              @input="$emit('lock-change', !$event.target.checked)"
            />
            允許控制
          </label>
          <button v-if="!isActive" class="ts-button is-fluid" @click="$emit('start-new-watch-together')">
            啟動{{ isWaiting ? '新的共同觀看' : '' }}
          </button>
          <button v-if="isActive" class="ts-button is-fluid" @click="$emit('copy-watch-together-link')">
            複製連結
          </button>
          <button v-if="isActive" class="ts-button is-fluid is-negative">解散</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.status-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-gap: 1rem;
}
.status-grid .ts-iconset,
.status-grid .ts-iconset .content {
  overflow: hidden;
  width: 100%;
}
.status-grid .ts-iconset .text {
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
