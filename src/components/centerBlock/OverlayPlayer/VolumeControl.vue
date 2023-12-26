<script setup>
defineProps({
  volume: {
    type: Number,
    required: true
  },
  isMuted: {
    type: Boolean,
    required: true
  },
  convertVolume: {
    type: Function,
    required: true
  }
})

defineEmits([
  'mute-button-pointerup',
  'volume-mousewheel',
  'reset-button-pointerup',
  'update:volume'
])
</script>

<template>
  <div class="is-flex">
    <button
      class="button has-flex-center"
      @pointerup="$emit('mute-button-pointerup', $event)"
      @wheel="$emit('volume-mousewheel', $event)"
    >
      <span v-if="isMuted" class="ts-icon tablet+:is-big is-volume-xmark-icon" />
      <span v-else-if="volume === 0" class="ts-icon tablet+:is-big is-volume-off-icon" />
      <span v-else-if="volume <= 50" class="ts-icon tablet+:is-big is-volume-low-icon" />
      <span
        v-else
        class="ts-icon tablet+:is-big is-volume-high-icon"
        :style="{ color: volume > 100 ? 'var(--ts-negative-400)' : 'var(--ts-white)' }"
      />
    </button>
    <input
      type="range"
      class="mobile:has-hidden has-cursor-pointer player-slider"
      :value="volume"
      :max="150"
      step="any"
      @input="$emit('update:volume', $event.target.value)"
      @wheel="$emit('volume-mousewheel', $event)"
    />
    <span
      class="mobile:has-hidden has-cursor-pointer"
      title="按一下重置音量"
      @pointerup="$emit('reset-button-pointerup', $event)"
    >
      {{ Math.round(convertVolume(volume)) }}%
    </span>
  </div>
</template>

<style scoped>
.button {
  width: 30px;
  height: 30px;
}

.is-flex {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

/* Workaround tocas-ui's important */
.auto-hidden .has-cursor-pointer,
.auto-hidden button {
  cursor: none !important;
}
</style>
