import { cloudflare } from '@cloudflare/vite-plugin';
import { sites } from '@openai/sites-vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    tailwindcss(),
    sites(),
    cloudflare({
      viteEnvironment: { name: 'server' },
      config: {
        name: 'oktw-live',
        main: './src/worker.js',
        compatibility_date: '2026-05-15',
        assets: {
          directory: './dist',
          not_found_handling: 'single-page-application',
          binding: 'ASSETS',
          run_worker_first: true,
        },
      },
    }),
  ],
});
