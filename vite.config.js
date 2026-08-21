/* eslint-env node */
import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const proxyTarget = process.env.OKTW_LAN_PROXY_TARGET
const createProxyOptions = () => ({
  target: proxyTarget,
  changeOrigin: true,
  followRedirects: true
})

// https://vitejs.dev/config/
export default defineConfig({
  base: '',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: proxyTarget
    ? {
        proxy: {
          '/live': createProxyOptions(),
          '/record': createProxyOptions()
        }
      }
    : undefined
})
