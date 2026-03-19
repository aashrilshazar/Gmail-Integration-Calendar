# Keyesight — Sales Calendar Dashboard

Unified weekly calendar view pulling from 4 keye.co Google Workspace accounts, with click-through detail panels showing Gmail threads, Notion meeting transcripts, and AI-generated summaries.

## Setup

### 1. Clone and install

```bash
npm install
```

### 2. Configure environment variables

Copy `.env.local.example` to `.env.local` and fill in:

- `GOOGLE_SERVICE_ACCOUNT_EMAIL` — from your service account JSON
- `GOOGLE_PRIVATE_KEY` — the full private key string (with `\n` literals)
- `GOOGLE_IMPERSONATE_ACCOUNTS` — comma-separated: `dani@keye.co,r.parikh@keye.co,rparikh@keye.co,rohan@keye.co`
- `NOTION_TOKEN` — from notion.so/my-integrations
- `NOTION_DATABASE_ID` — 32-char ID from your Notion database URL
- `ANTHROPIC_API_KEY` — for deal summaries

### 3. Run locally

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### 4. Deploy to Vercel

```bash
npx vercel --prod
```

Add all env vars in Vercel dashboard → Settings → Environment Variables.

**Important for `GOOGLE_PRIVATE_KEY`:** Paste the full key including `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----`. Vercel handles the newlines.

## Architecture

```
pages/
  index.js              — Calendar UI (weekly view, event tiles, detail panel)
  api/
    calendar.js         — Fetches events from all 4 Google Calendar accounts
    event/
      detail.js         — Fetches Gmail threads, Notion meetings, Claude summary

lib/
  google.js             — Google auth with domain-wide delegation
  notion.js             — Notion client for meeting transcript search
```

## How it works

1. **Calendar API** uses a single Google service account with domain-wide delegation to impersonate all 4 keye.co accounts. Events are merged and deduped.

2. **Click any event** → the detail panel extracts a company name from the event title, then:
   - Searches Gmail across all 4 accounts for threads mentioning that company
   - Searches Notion for matching meeting transcripts
   - Sends the aggregated context to Claude for a deal summary

3. **No database.** Notion is the transcript store, Google is the email/calendar store, Claude is the analyst. This app just orchestrates the API calls.
