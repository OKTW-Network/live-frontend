<script setup>
import { computed, nextTick, ref, watch } from 'vue'

import MessageBubble from './MessageBubble.vue'

const props = defineProps({
  viewerCount: Number,
  messages: Array,
  uuid: Array,
  nickname: String,
  ready: Boolean
})

defineEmits(['send-message', 'set-nickname'])

const historyRef = ref(null)
const message = ref('')

const bulletMessages = computed(
  () => props.messages?.filter((i) => i.type === 'bulletScreenMessage') ?? []
)

const followChat = () => {
  // Prefer instant scroll to avoid smooth-scroll animations competing with video frames.
  historyRef.value?.scrollTo({ top: historyRef.value?.scrollHeight, left: 0, behavior: 'auto' })
}

watch(
  () => bulletMessages.value.length,
  async () => {
    await nextTick()
    followChat()
  }
)
</script>

<template>
  <div class="ts-app-layout is-vertical">
    <!-- Header -->
    <div class="cell">
      <div class="ts-content">
        <div class="ts-text is-bold is-center-aligned">Chatroom ({{ viewerCount }})</div>
      </div>
    </div>
    <!-- History -->
    <div ref="historyRef" class="cell is-fluid is-scrollable">
      <div class="ts-content">
        <MessageBubble
          v-for="(value, index) in bulletMessages"
          :key="value.id ?? `${value.uuid}-${index}`"
          :index="index"
          :is-self="uuid.includes(value.uuid)"
          :author="value.sentFrom"
          :text="value.msg"
          :received-at="value.receivedAt"
        />
      </div>
    </div>
    <!-- Input -->
    <div class="cell">
      <div class="ts-content is-dense">
        <div class="ts-input is-start-labeled" :class="{ 'is-disabled': !ready }">
          <input
            class="label"
            style="padding-right: 0%; max-width: 33%"
            type="text"
            placeholder="Nickname"
            :value="nickname"
            @focusout="(event) => $emit('set-nickname', event.target.value)"
          />
          <input
            class="text"
            v-model="message"
            type="text"
            placeholder="Messages..."
            @keydown="
              (event) => {
                if (event.key === 'Enter' && message.length > 0) {
                  $emit('send-message', message)
                  message = ''
                  followChat()
                }
              }
            "
          />
        </div>
      </div>
    </div>
  </div>
</template>
