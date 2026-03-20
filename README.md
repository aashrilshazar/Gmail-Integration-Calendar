# Keye Lookup API

Serverless API that aggregates Gmail and Calendar data across 6 keye.co accounts and generates AI summaries for any firm.

## Setup

### 1. Install

```bash
npm install
```

### 2. Configure environment variables

Create a `.env` file:

- `GOOGLE_SERVICE_ACCOUNT_EMAIL` — from your service account JSON
- `GOOGLE_PRIVATE_KEY` — the full private key string (with `\n` literals)
- `GOOGLE_IMPERSONATE_ACCOUNTS` — comma-separated keye.co emails
- `ANTHROPIC_API_KEY` — for AI summaries

### 3. Run locally

```bash
npm run dev
```

### 4. Deploy to Vercel

```bash
npx vercel --prod
```

Add all env vars in Vercel dashboard > Settings > Environment Variables.

## Usage

```bash
curl -X POST https://your-project.vercel.app/api/lookup \
  -H "Content-Type: application/json" \
  -d '{"firm": "Closed Loop Partners"}'
```

## Architecture

```
api/
  lookup.js       — Vercel serverless function (Gmail + Calendar + Claude summary)

lib/
  google.js       — Google auth with domain-wide delegation

server.js         — Express server for local dev
```
