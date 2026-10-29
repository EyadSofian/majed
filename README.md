# Majed «نور» — Engosoft chat assistant

Majed is the AI learning advisor on the Engosoft Odoo website. Start with
[`MAJED_MASTER_DOC.md`](MAJED_MASTER_DOC.md) — it has the full architecture, current state and env vars.

```
Odoo site  →  «نور» widget (integration/bridge/public/majed-widget.js)
           →  bridge on Railway (integration/bridge/index.js)
                 ├→ Botpress Cloud — the bot brain (Chat API)
                 └→ Chatwoot — source of truth + human agents
```

| Path | What it is |
|------|------------|
| `integration/bridge/` | The bridge (Express) + the widget it serves at `/majed-widget.js`. This is what Railway deploys. |
| `integration/odoo/ai_user_context_webhook/` | Odoo module that injects the widget and exposes trainee context. |
| `integration/BOTPRESS_*.md` | Majed's Botpress prompts and setup guides (paste into Botpress Studio). |
| `*.html`, `server.js` (repo root) | Early design mockups and a static preview server — not used in production. |

## Bridge locally

```bash
cd integration/bridge && npm install && npm start
```

Tests: `node test/notify-takeover.test.js` (unit) and `node test/e2e-mock.js` (fake Chatwoot + Botpress).

## Static mockup preview

```bash
npm start
```

Serves the root mockups on `http://localhost:3000`.
