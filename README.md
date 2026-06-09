# Majed Liquid Widget

Self-hosted Chatwoot launcher styled as a single Majed avatar that **opens the chat directly** — no radial four-icon menu.

- Circular liquid-glass launcher with the Majed avatar + online dot.
- Clicking the avatar opens the chat panel straight away (header with back / restart / email, WhatsApp inside the input, `by Engosoft` credit).
- Chatwoot SDK loads from `https://chat.engosoft.com` with `hideMessageBubble: true`, so our avatar replaces the default bubble. The avatar drives `$chatwoot.toggle("open" / "close")`.
- If Chatwoot is not ready in local preview, the avatar opens a styled fallback panel (loading dots → greeting) that mirrors the live widget.

## Local

```bash
npm start
```

Open `http://localhost:3000`. Append `?open=1` to auto-open the chat.

## Railway

Create a Railway project from this folder or a GitHub repo containing these files. Railway runs:

```bash
npm start
```
