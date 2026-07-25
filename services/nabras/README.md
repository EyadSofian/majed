# نبراس — Engosoft AI Course Advisor

Sales-capable, page-aware course assistant for the Engosoft Odoo 17 site.
Built to beat eyouth's **فاهم (Fahym)** on the three gaps the audit found:
**real token streaming**, **live price + a full checkout funnel**, and a
**rate-limited** guest endpoint.

---

## 1. Architecture

```
 SOURCE OF TRUTH                HOT READ LAYER                 CHAT RUNTIME
┌──────────────┐  n8n sync   ┌──────────────┐   semantic   ┌─────────────────────┐
│  Odoo 17     │  (6h)       │  Pinecone    │◄────────────►│ LangChain agent      │
│ product.tmpl │────────────►│  (vectors +  │   top-k      │ (create_agent)       │
│  crm.lead    │             │   metadata)  │              │  + Postgres memory   │
└──────┬───────┘             └──────────────┘              └─────────┬───────────┘
       │  live point-lookup (price / availability) at the money-moment│  SSE stream
       └─────────────────────────────────────────────────────────────┘  → widget
```

**The data decision.** Odoo is the source of truth, but the chat never queries it
per message — that would couple chat latency to Odoo load. Instead:

- **Bulk catalog → Pinecone** every 6h via `sync/odoo_to_pinecone.n8n.json`. Chat
  reads are fast and survive Odoo downtime.
- **Odoo is hit only at the money-moment**: `get_course_live` confirms real price
  and availability immediately before `build_checkout_link`. Accuracy where it
  costs money, speed everywhere else.

**Memory** is `AsyncPostgresSaver` keyed by `session_id`, so conversations survive
restarts (an `InMemorySaver` would not).

---

## 2. API contract

Deliberately shaped like Fahym's so an existing widget can be pointed at it with
minimal change (it accepts `fahem_session_id`).

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/v1/user/guest-session/create/` | → `{data:{guest_token}}`, JWT HS256 with `exp`. Rate-limited per IP. |
| `POST` | `/api/v1/ai-chat/chat/` | `X-Guest-Token` (or `Authorization: Bearer`). **SSE stream.** |
| `GET`  | `/api/v1/ai-chat/history/{session_id}/` | Replays persisted turns. |
| `GET`  | `/health` | Liveness. |

**Request**

```json
{"message":"عايز اتعلم Power BI","fahem_session_id":"s_123","language":"auto",
 "page_type":"courseDetail","slug":"power-bi-data-analysis"}
```

**SSE events** — text streams first, cards arrive as one structured payload
(decoupled from token generation, so the model can never garble them):

```
data: {"type":"token","content":"أنصحك "}
data: {"type":"cards","course_cards":[{...,"checkout_url":"https://…"}]}
data: {"type":"done"}
data: {"type":"error","message":"upstream_error"}     ← only on failure
```

`course_card` = `course_id, title, slug, url, thumbnail_url, rating,
price_display, checkout_url`.

---

## 3. Tools the agent can call

| Tool | Hits | Purpose |
|---|---|---|
| `search_courses` | Pinecone | Semantic catalog search. The only source of course facts. |
| `get_course_live` | Odoo | Real-time price + availability. |
| `build_checkout_link` | Odoo | Express add-to-cart → checkout deep link; attaches it to the card. |
| `create_lead` | Odoo `crm.lead` | Captures hesitant buyers, assigned to the sales advisor (`user_id=2`). |
| `escalate_to_chatwoot` | Chatwoot | Human handoff (HITL). |

---

## 4. Run

```bash
cp .env.example .env            # fill OPENAI / PINECONE / ODOO keys
docker compose up --build

curl -XPOST localhost:8080/api/v1/user/guest-session/create/
curl -N -XPOST localhost:8080/api/v1/ai-chat/chat/ \
  -H "X-Guest-Token: <token>" -H "Content-Type: application/json" \
  -d '{"message":"عايز اتعلم Power BI","fahem_session_id":"s_test"}'
```

### Tests and the offline demo

No API keys needed — the model, Pinecone and Odoo are faked; the FastAPI app and
the LangGraph agent are real.

```bash
pip install -r requirements-dev.txt
pytest -q                             # 18 tests

python scripts/demo_server.py &       # :8099
python scripts/demo_trace.py          # timed 4-turn sales conversation
```

---

## 5. Verified behaviour (last run)

18/18 tests green. The demo trace walks a full funnel — discover → recommend →
price objection → close → lead capture:

| Turn | Result | TTFT | Total |
|---|---|---|---|
| 1 recommend | 3 cards streamed | 46 ms | 630 ms |
| 2 objection (from memory, no tool call) | answered from prior turn | 36 ms | 620 ms |
| 3 close | live price → **card with `checkout_url`** | 43 ms | 502 ms |
| 4 hesitation | `crm.lead` #5001 → advisor `user_id=2` | 38 ms | 284 ms |

12 messages persisted and replayable via `/history/`. Guardrails: no token →
401, forged token → 401, malformed payload → 422, 35 mint attempts → 29×200 +
6×429.

*(Timings are pipeline overhead against a scripted model — they measure the
service, not the LLM. The point they prove is that TTFT is independent of
total: the user starts reading while generation continues.)*

### Two bugs the live test caught

1. **Zero tokens would have streamed.** `langgraph.prebuilt.create_react_agent`
   is deprecated in LangGraph 1.0; the replacement `langchain.agents.create_agent`
   names its model node `"model"`, not `"agent"`. Filtering the stream by node
   name silently emitted nothing. `main.py` now filters by **message type**
   (`AIMessageChunk`), which is correct under both.
2. **Closing turns produced no buy button.** A close usually skips
   `search_courses` (the course is already known), so there was no card for
   `build_checkout_link` to attach `checkout_url` to — the reply said "press
   buy" with no card rendered. It now materialises a card from Odoo. Covered by
   `test_close_only_turn_still_emits_a_buyable_card`.

---

## 6. Models

The GPT-5.6 family (July 2026) — Sol `$5/$30`, **Terra `$2.50/$15`**, Luna
`$1/$6`, ~1M context.

- **Agent** → `gpt-5.6-terra`: the best tool-use/price balance for a sales agent.
- **Router / summaries** → `gpt-5.6-luna`.
- **Embeddings** → `text-embedding-3-large` (3072 dims).
- The system prompt is byte-identical every turn, so **prompt caching** applies:
  cached input reads are 90% cheaper. Note cache *writes* bill at 1.25× on
  GPT-5.6+, so caching pays off from the second turn of a session onward — which
  is nearly all of them.
- Start on Terra; only move to Sol if evals show a real quality gap.
- `AGENT_TEMPERATURE=-1` omits the parameter entirely for tiers that reject it.

---

## 7. Before production — confirm these three

1. **Odoo course model.** This assumes courses are `product.template`
   (eCommerce products). If Engosoft courses live in eLearning
   (`slide.channel`), set `ODOO_COURSE_MODEL` and adjust the field lists in
   `tools.get_course_live` / `_card_from_odoo` and the sync Code node.
2. **Express checkout URL.** `/shop/cart/update?product_id=..&add_qty=1&express=1`
   depends on your eCommerce config. If express is off, fall back to the
   product's `website_url`.
3. **Pinecone index.** Create it `dim=3072, metric=cosine`; put the index host
   into the sync workflow's `Config.PINECONE_HOST` and add an `httpHeaderAuth`
   credential with header `Api-Key`.

### Known limits

- Rate limits are in-process dicts — fine for one replica, needs Redis beyond that.
- `escalate_to_chatwoot` creates a contact + conversation but does not yet
  replay the transcript into it.
- Cards from `search_courses` show `price_display` as synced from Odoo (`$120`),
  while the checkout fallback card shows the live figure (`120 USD`). Normalise
  in the widget or in the sync workflow.
