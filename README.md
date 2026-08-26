# ON LIVE (live-next)

Alpine + Vite frontend for browsing streamers, live playback, recordings, and chat.

## Requirements

- Node.js `>=22.13.0` (see `package.json` `engines`)

## Scripts

```bash
npm install
npm run dev      # Vite dev server with /__upstream proxy to live.oktw.one
npm test         # node --test
npm run build    # static assets in dist/
npm run preview  # preview the production build
```

## Deploy

`npm run build` emits a static SPA in `dist/`.

History API routes (`/@streamer`, `/record/...`, `/records`) need an SPA fallback on the host
(`try_files` / `not_found_handling` → `index.html`) so hard refresh does not 404.

Dev and `vite preview` already rewrite unknown paths to `index.html`.
