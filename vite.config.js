import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const upstreamProxy = {
  target: 'https://live.oktw.one',
  changeOrigin: true,
  secure: true,
  ws: true,
  followRedirects: true,
  rewrite: (path) => path.replace(/^\/__upstream/, ''),
};

export default defineConfig({
  plugins: [tailwindcss()],
  server: {
    proxy: {
      '/__upstream': upstreamProxy,
    },
  },
});
