import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const hmrClientPort = Number(process.env.VITE_HMR_CLIENT_PORT);

export default defineConfig({
  plugins: [tailwindcss()],
  server: {
    host: true,
    // When Vite is behind docker/nginx on another port, set VITE_HMR_CLIENT_PORT
    // so the browser connects HMR to the proxy (e.g. 8080) instead of :5173.
    ...(Number.isFinite(hmrClientPort) && hmrClientPort > 0
      ? { hmr: { clientPort: hmrClientPort } }
      : {}),
  },
});
