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

### Local reverse proxy (Docker)

```bash
VITE_HMR_CLIENT_PORT=8080 npm run dev -- --host 0.0.0.0 --port 5173
docker compose -f docker-compose.dev.yml up
```

Open `http://127.0.0.1:8080/` (or your LAN IP on port 8080). Nginx proxies SPA/HMR to Vite, `/live` `/ws` and non-video `/record` to `live.oktw.one`, and `/record/*.mp4` straight to S3 (`s3.licson.net/oktw-live/…`) so the browser never sees the upstream 302 and stays same-origin.

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
