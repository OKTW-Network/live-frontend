# ON LIVE (live-next)

Alpine + Vite frontend for browsing streamers, live playback, recordings, and chat.

API, media, and chat WebSocket URLs are **same-origin relative paths** (`/record/...`, `/live/...`, `/ws`). Development and production are expected to sit behind a reverse proxy that serves this SPA and forwards those paths upstream.

## Requirements

- Node.js `>=22.13.0` (see `package.json` `engines`)

## Scripts

```bash
npm install
npm run dev      # Vite only — needs a reverse proxy in front for API/media/WS
npm test         # node --test
npm run build    # static assets in dist/
npm run preview  # preview the production build
```

## Routes

| Path | Who serves it |
|------|----------------|
| `/`, `/records`, `/@streamer`, `/watch/:filename` | SPA (`index.html`) |
| `/record/...`, `/live/...`, `/ws` | Upstream via reverse proxy |

SPA page routes must not collide with media paths (`/watch/...` vs `/record/...`).

## Deploy

`npm run build` emits a static SPA in `dist/`.

Configure the host so History API routes fall back to `index.html`, while `/record`, `/live`, and `/ws` still reach upstream.

Dev and `vite preview` already rewrite unknown paths to `index.html`.
