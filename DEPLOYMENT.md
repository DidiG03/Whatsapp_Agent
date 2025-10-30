# Deployment Guide

This project is production-ready and supports multiple deployment targets.

## Requirements
- Node.js 20+
- MongoDB
- Optional: Redis for rate-limiting and caching
- Environment variables (see `env.example`)

## Environment Configuration
1. Copy `env.example` to `.env` (or configure variables in your platform dashboard)
2. Fill in required secrets (Clerk, Stripe, MongoDB, SMTP, etc.)

## Docker
Build and run locally:

```bash
docker build -t whatsapp-agent:latest .
docker run --env-file ./.env -p 3000:3000 --name whatsapp-agent whatsapp-agent:latest
```

The image runs as a non-root user and exposes `/health` for liveness.

## CI/CD
- `.github/workflows/ci.yml`: installs dependencies, runs tests, and uploads coverage.
- `.github/workflows/docker-build.yml`: builds and pushes images to GHCR (`ghcr.io`).

Grant `packages: write` permission and use the default `GITHUB_TOKEN` (already configured). Images are tagged with commit SHA, branch, and semver (if tagged).

## Vercel (Serverless)
This project includes a serverless adapter at `api/index.js`. Deploying to Vercel creates a single serverless function (within your limit of 12). Configure environment variables in Vercel. Socket.io support is limited under serverless.

## Bare Metal / VM
Run directly:

```bash
npm ci
npm start
```

## Health, Metrics, and Logs
- Health: `GET /health`, `GET /health/detailed`, `GET /health/scalability`
- Metrics: `GET /metrics` (if enabled)
- Structured logs via Winston with correlation IDs. Log level controlled by `LOG_LEVEL`.

## Security
- Security headers and input sanitization are enforced.
- Rate limits for general API and webhooks.
- Webhook signature verification is supported where configured.

## Notes
- Use `MEDIA_SIGN_SECRET` to protect `/uploads` URLs or set `MEDIA_SIGNING_DISABLED=1` for local use.
- Ensure `PUBLIC_BASE_URL` is set correctly for links in notifications.
