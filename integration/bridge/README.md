# Chatwoot-Botpress Bridge

Bridge server to connect Chatwoot with Botpress Messaging API.

## Setup on Railway

1. Go to [Railway.app](https://railway.app)
2. Sign up / Login with GitHub
3. Click "New Project" → "Deploy from GitHub repo"
4. Upload this code or connect your repo
5. Railway will auto-detect Node.js and deploy

## Environment Variables (Optional)

You can set these in Railway dashboard instead of hardcoding:

```
CHATWOOT_BASE_URL=https://your-chatwoot.example.com
CHATWOOT_ACCOUNT_ID=your_account_id
CHATWOOT_API_TOKEN=your_token
BOTPRESS_WEBHOOK_URL=https://webhook.botpress.cloud/your-webhook-id
BOTPRESS_PAT=optional_botpress_pat
```

## Endpoints

- `POST /chatwoot/webhook` - Receives messages from Chatwoot
- `POST /botpress/webhook` - Receives responses from Botpress
- `POST /widget/subscribe` - Newsletter opt-in from the widget
- `GET /admin` - Subscribers dashboard (Basic auth, password = `ADMIN_PASSWORD`)
- `GET /unsubscribe?token=…` - Public one-click unsubscribe link (used in emails)
- `GET /` - Health check

## Newsletter (subscribers + broadcast)

Email opt-ins captured by the widget are stored and managed by the bridge itself:

- **Storage** — PostgreSQL when `DATABASE_URL` is set (add a PostgreSQL plugin in
  Railway; it injects the var). Without it the bridge falls back to a local
  `data/subscribers.jsonl` file — fine for dev, but Railway's disk is ephemeral, so
  use Postgres in production.
- **Dashboard** — open `/admin` (HTTP Basic auth: any username, password =
  `ADMIN_PASSWORD`). View/search subscribers, export CSV, send a test email, and
  broadcast an update to all active subscribers.
- **Sending** — over Engosoft SMTP (`SMTP_*` vars). If `SMTP_HOST` is unset the
  dashboard runs in **dry-run** mode (logs instead of sending) so you can try it
  safely. Every email includes an unsubscribe link built from `PUBLIC_BASE_URL`, so
  set that for broadcasts to work.

See `.env.example` for the full list (`DATABASE_URL`, `PGSSL`, `ADMIN_PASSWORD`,
`SMTP_HOST/PORT/SECURE/USER/PASS`, `MAIL_FROM`, `PUBLIC_BASE_URL`).

## Configuration

After deploying on Railway, you'll get a URL like:
`https://your-app.railway.app`

### In Chatwoot:
- Go to Settings → Integrations → Webhooks
- Add webhook: `https://your-app.railway.app/chatwoot/webhook`
- Select events: `message_created`

### In Botpress:
- Go to Messaging API integration settings
- Set Response Endpoint URL: `https://your-app.railway.app/botpress/webhook`

---

## Botpress → Bridge payload (what Botpress should send)

The bridge forwards trainee context to Botpress on each incoming message
(`userData` + `metadata`: `courses_json`, `progress_percent`, ...).

In its reply, Botpress can send **text**, **interactive buttons/cards**, and
**handoff/assignment actions**. Botpress owns all routing logic (which team, when).

Reply body shape (any combination):

```jsonc
{
  // conversation id is auto-detected from conversationId / metadata.chatwootConvId
  "messages": [
    { "text": "أهلاً، أنا ماجد 👋" },

    // interactive buttons rendered INSIDE the Chatwoot chat window
    {
      "content": "اختر طريقة التواصل:",
      "content_type": "input_select",
      "content_attributes": {
        "items": [
          { "title": "واتساب", "value": "whatsapp" },
          { "title": "إيميل",  "value": "email" },
          { "title": "ماجد فويس (قريبًا)", "value": "voice_soon" }
        ]
      }
    }
    // ("content_type": "cards" with actions[].uri also supported for links)
  ],

  // handoff to a human — Botpress decides WHEN and WHICH team
  "actions": [
    { "type": "handoff", "team_id": 3 }        // status -> open + assign team
    // { "type": "assign", "assignee_id": 12 } // assign a specific agent
    // { "type": "status", "status": "resolved" }
  ]
}
```

Shorthands also accepted: top-level `text`, or `handoff: { "team_id": 3 }`.

| Action | Chatwoot API called |
|--------|---------------------|
| `handoff` | `toggle_status` → `open` then `assignments` (team/agent) |
| `assign`  | `assignments` |
| `status`  | `toggle_status` |

> Use case mapping (handled in Botpress): "ريسيل" → `team_id` of sales team,
> "شكوى" → `team_id` of complaints team, etc. The bridge just executes.
