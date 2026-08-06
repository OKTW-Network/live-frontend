<script setup>
defineProps({
  index: Number,
  isSelf: Boolean,
  author: String,
  text: String,
  receivedAt: {
    type: Number,
    default: undefined
  }
})

const formatTime = (receivedAt) => {
  const date = receivedAt ? new Date(receivedAt) : new Date()
  return date.toLocaleTimeString('en-US')
}
</script>

<template>
  <div class="ts-conversation is-sent" :class="{ 'is-self': isSelf, 'has-top-spaced': index > 0 }">
    <div class="has-break-all content">
      <div class="bubble">
        <div class="author">{{ author }}</div>
        <div class="text">{{ text }}</div>
        <div class="meta">
          <div class="item">{{ formatTime(receivedAt) }}</div>
        </div>
      </div>
    </div>
  </div>
</template>
