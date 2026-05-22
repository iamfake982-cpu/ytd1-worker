# ytdl-worker

Self-hosted yt-dlp + ffmpeg worker for the Lovable YouTube Downloader app.

## Required env vars
- `WORKER_TOKEN` — shared secret (paste the same value in the app's Settings)
- `PUBLIC_BASE_URL` — public https URL of this worker (e.g. https://my-ytdl.fly.dev)
- `DATA_DIR` — defaults to `/data` (persistent volume)
- `CONCURRENCY` — parallel downloads, default 2
- `YTDLP_COOKIES` — optional Netscape cookies text or base64 text for age-restricted / bot-check YouTube failures

## Fly.io deploy
```bash
fly launch --no-deploy
fly volumes create ytdl_data --size 10
fly secrets set WORKER_TOKEN=$(openssl rand -hex 32) \
                PUBLIC_BASE_URL=https://<your-app>.fly.dev
fly scale memory 1024
fly deploy
fly ssh console -C "printenv WORKER_TOKEN"   # copy into app Settings
```

## Local docker
```bash
docker build -t ytdl-worker .
docker run -p 8080:8080 -v $PWD/data:/data \
  -e WORKER_TOKEN=secret -e PUBLIC_BASE_URL=http://localhost:8080 \
  ytdl-worker
```

## Endpoints
- `POST /jobs` (Bearer auth) — `{jobId,url,format,webhookUrl,webhookToken}`
- `GET /files/:jobId/:name` — download finished file
- `DELETE /jobs/:jobId` (Bearer auth)
- `GET /health` — includes whether optional cookies were loaded
