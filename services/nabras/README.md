# نبراس — Engosoft AI Course Advisor

Sales-capable, page-aware course assistant for the Engosoft Odoo 17 site. Built
to beat eyouth's **فاهم (Fahym)** on the three gaps the audit found — **real
token streaming**, **live price + a full checkout funnel**, and a
**rate-limited** guest endpoint — using data Fahym does not have: live batch
dates, remaining seats, named instructors and multi-course packages.

---

## 1. What the live Odoo actually looks like

Everything below was measured against the production database, not assumed.
Each one is a trap that produces a *plausible but wrong* answer to a paying
customer, which is why they are called out here and covered by tests.

| Finding | Why it matters |
|---|---|
| Courses are `product.template` with the custom `detailed_type='course'` — 115 rows, 75 published + sellable | The other 353 products are events, booking fees, consumables. Skip the filter and the bot recommends non-courses. |
| **`list_price` is 0 on effectively every course** (1 row out of 115 has a value) | Real prices live in `product.pricelist.item`. Quoting `list_price` tells the customer the course is free. |
| Prices are per-region: EGP / USD / AED / SAR, via 4 website pricelists | A single "price" does not exist. The visitor's currency decides. |
| Pricelist items come in **two shapes** — `applied_on='1_product'` (+`product_tmpl_id`) and `applied_on='0_product_variant'` (+`product_id`) | Reading only the newer shape leaves older courses priced at zero. |
| `event.event.event_registrations_open` is computed and **not stored** | Odoo silently ignores it in a domain — `search_count` on it returns *every* row. It must be filtered in Python. |
| `event.event.ticket.price` is `1` on every ticket | Another placeholder. Same trap as `list_price`. |
| `slide.channel.website_url` is absolute; `product.template.website_url` is relative | Prefixing the host onto both yields `engosoft.comhttps://…`. |
| Images are binary columns, never URLs | The URL is derived: `/web/image/product.template/<id>/image_1920`. Requesting `image_1920` itself returns megabytes of base64. |
| Courses join the LMS through `slide.channel.product_id` → **`product.product`** (variant), with no reverse field | Going product→course needs a search, not a field read. |
| 84 of 85 upcoming batches are in Riyadh (`Asia/Riyadh`, SAR) | An Egyptian visitor asking about an attendance course is being offered Saudi Arabia. The bot says so up front instead of at checkout. |
| Instructors are real records — `hr.employee` via `recorded_instructor_ids` / `attendance_instructor_ids` / `event.instructor_id` | Names also appear inside free text (`"July Group 2026 (Alaa Saleh - 5452)"`, `"E-Alaa Saleh"`). Parsing those would invent people. |
| Packages are a full model family: `training.package` → `.level` → `.product.line` → `.group` → `event.event` | 70 of 85 upcoming batches belong to a package. This is the highest-value offer. |

### Catalogue size changed the architecture

**75 sellable courses.** A vector database is dead weight at that size, so there
is none: the catalogue is held in memory, searched directly, and summarised into
the system prompt (~3k tokens, identical between turns, so prompt caching makes
it nearly free). That removes Pinecone, the embedding spend and the 6-hour sync
job that the first design called for — and a new course now appears in 5 minutes
instead of 6 hours.

---

## 2. Architecture

```
        ┌──────────────────────────── Odoo 17 (source of truth) ─────────────┐
        │  product.template · product.pricelist.item · slide.channel         │
        │  event.event · hr.employee · training.package* · crm.lead          │
        └───────┬───────────────────────────────────────────┬───────────────┘
     delta poll │ write_date, every 5 min                   │ live, per request
                ▼                                           ▼
        in-memory catalogue  ──► system prompt digest    price · seats · checkout
                │                    (prompt-cached)
                ▼
        LangChain create_agent  ── SSE ──►  bridge  ──►  «نور» widget
        + Postgres memory                    │
                                             └──► Chatwoot (bridge owns it)
```

**Freshness, by how much staleness costs:**

| Data | Mechanism | Lag |
|---|---|---|
| **Price** | Never cached — read live at every quote and every checkout link | **zero** |
| **Seats / batches** | Refetched on each catalogue refresh | ≤ 5 min |
| New course, package, description | Delta poll on `write_date` | ≤ 5 min |

The delta poll is one query that returns `[]` 99% of the time. No Odoo changes,
no webhook, no n8n dependency. For instant updates, add an Odoo Automated Action
on create/write that pings the service — but 5 minutes is fine for a catalogue.

**Nabras never writes to Chatwoot.** The bridge owns conversation status, team
assignment and auto-return; two writers would fight over the same state. The
agent raises a `handoff` event on the stream and the bridge acts on it.

---

## 3. API

Deliberately shaped like Fahym's, so the existing widget can be pointed at it
with minimal change (it accepts `fahem_session_id`).

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/v1/user/guest-session/create/` | → `{data:{guest_token}}`. JWT HS256 with `exp`. Rate-limited per IP. |
| `POST` | `/api/v1/ai-chat/chat/` | `X-Guest-Token` or `Authorization: Bearer`. **SSE stream.** |
| `GET` | `/api/v1/ai-chat/history/{session_id}/` | Replays persisted turns. |
| `GET` | `/health` | Liveness + catalogue size + package availability. |

```json
{"message":"عايز أدخل مجال BIM","fahem_session_id":"s_123","language":"auto",
 "currency":"EGP","page_type":"courseDetail","slug":"navisworks-mep-2107"}
```

SSE events — text streams first, structured payloads follow, decoupled from
token generation so the model cannot garble them:

```
data: {"type":"token","content":"أنصحك "}
data: {"type":"cards","course_cards":[…],"currency":"EGP"}
data: {"type":"packages","package_cards":[…]}
data: {"type":"handoff","requested":true,"reason":"price_objection","summary":"…"}
data: {"type":"done"}
```

`course_card` = `course_id, title, url, image_url, price_display, currency,
rating, delivery, duration_text, categories[], instructors[], next_batch{},
batches_count, checkout_url`.

`next_batch` = `event_id, starts_at, ends_at, timezone, location,
seats_available, seats_max, registration_open, url`.

**The widget already renders these.** `majed-widget.js:1103` `addCard()` takes
`title` / `description` / `media_url` / `actions[]`, and `checkout_url` maps
onto `{type:'link'}` — a buy button, with no widget rewrite.

---

## 4. Tools

| Tool | Reads | Purpose |
|---|---|---|
| `search_courses` | memory | Catalogue search, filterable by category and delivery format. |
| `get_course_details` | memory + Odoo | One course in full: price, instructors, batches, certificate. |
| `get_upcoming_batches` | memory | Bookable runs with dates, timezone, location, seats left. |
| `get_price` | **Odoo, live** | The only sanctioned source of a number. |
| `get_instructor` | Odoo | Named instructors from `hr.employee`. |
| `search_packages` | memory | Multi-course tracks with package price and discount. |
| `build_checkout_link` | Odoo | Express add-to-cart → checkout, attached to the card. |
| `create_lead` | Odoo | `crm.lead` for the sales advisor (`user_id=2`). |
| `request_handoff` | — | Signals the bridge. Does not touch Chatwoot. |

---

## 5. Run

```bash
cp .env.example .env            # fill OPENAI_API_KEY and ODOO_API_KEY
docker compose up --build

curl -XPOST localhost:8080/api/v1/user/guest-session/create/
curl -N -XPOST localhost:8080/api/v1/ai-chat/chat/ \
  -H "X-Guest-Token: <token>" -H "Content-Type: application/json" \
  -d '{"message":"عايز أدخل مجال BIM","fahem_session_id":"s","currency":"EGP"}'
```

### Tests and offline demo — no keys, no network

```bash
pip install -r requirements-dev.txt
pytest -q                             # 35 tests

python scripts/demo_server.py &       # :8099
python scripts/demo_trace.py          # timed 5-turn sales conversation
```

The FastAPI app, the agent, the catalogue and the pricing logic are all real;
only the model and Odoo are faked. The fakes reproduce the traps above
(`list_price=0`, both pricelist shapes, a closed-registration batch, absolute vs
relative URLs) so a regression fails the suite instead of a customer.

---

## 6. Verified behaviour (last run)

35/35 green. The demo trace walks a full funnel — discover → price objection →
dates and seats → close → hesitation → lead + human handoff:

| Turn | Result | TTFT | Total |
|---|---|---|---|
| 1 discover | 1 package + 2 course cards, with instructors | 63 ms | 531 ms |
| 2 price | 4,815 EGP from the pricelist (row says 0) | 40 ms | 416 ms |
| 3 dates | next batch 20 Aug, Riyadh time, 3 seats left | 40 ms | 322 ms |
| 4 close | card gains a **checkout link** | 40 ms | 330 ms |
| 5 hesitation | `crm.lead` → advisor, then `handoff` → bridge | 44 ms | 265 ms |

Guardrails: no token → 401, forged token → 401, malformed payload → 422, 35 mint
attempts → 29×200 + 6×429.

*(Timings are pipeline overhead against a scripted model — they measure the
service, not the LLM. What they prove is that TTFT is independent of total: the
customer reads while generation continues. Fahym cannot do this at all, because
Botpress's Chat API delivers whole messages, never tokens.)*

### Bugs the live tests caught

1. **Zero tokens would have streamed.** `langgraph.prebuilt.create_react_agent`
   is deprecated in LangGraph 1.0; the replacement `langchain.agents.create_agent`
   names its model node `"model"`, not `"agent"`. Filtering the stream by node
   name emitted nothing. `main.py` now filters by **message type**.
2. **Handoff never reached the bridge.** `HANDOFF_SINK.set(...)` inside a tool is
   invisible to the streaming generator: LangGraph runs tools in child tasks
   whose context is a *copy*, so a rebind is lost while mutating a shared
   container is not. Every sink is now mutated in place.
3. **Closing turns produced no buy button.** A close skips `search_courses`, so
   there was no card for `build_checkout_link` to attach `checkout_url` to. It
   now materialises one. Same for `get_price`.

---

## 7. Models

GPT-5.6 family (July 2026) — Sol `$5/$30`, **Terra `$2.50/$15`**, Luna `$1/$6`.

- **Agent** → `gpt-5.6-terra`: best tool-use/price balance for a sales agent.
- **Router / summaries** → `gpt-5.6-luna`.
- The system prompt (rules + catalogue digest) is byte-identical between turns,
  so **prompt caching** applies: cached input reads are 90% cheaper. Cache
  *writes* bill at 1.25× on GPT-5.6+, so it pays from the second turn of a
  session onward — nearly all of them. `agent.refresh_prompt()` only recompiles
  when the catalogue content hash changes, precisely to protect this.
- `AGENT_TEMPERATURE=-1` omits the parameter for tiers that reject it.

---

## 8. Open item — package permissions

`training.package` and its four related models need groups the bot's Odoo user
(`uid 15577`) does not have. Until they are granted, `search_packages` returns
empty and the chat continues normally — packages are simply never offered, which
costs the highest-value sale in the catalogue (70 of 85 upcoming batches belong
to one).

**Grant on the bot user — recommended:** `eLearning / Manager` + `Operation Group`

```
eLearning/Manager  →  training.package · training.package.level · target.audience.point
Operation Group    →  training.package.group · .product.line
                      .attendee.product.line · learning.outcome
```

`Website / Editor and Designer` also covers all seven on its own, but it grants
website-editing rights — too much for a read-only bot. The cleanest production
answer is a dedicated read-only ACL on those models.

Verify with `GET /health` → `packages_available: true`.

### Other known limits

- Rate limits are in-process dicts — fine for one replica, needs Redis beyond that.
- Pricelist rules with `compute_price` other than `fixed` are skipped rather
  than approximated; the bot sends the course URL instead of guessing a number.
- Express checkout (`/shop/cart/update?…&express=1`) depends on the eCommerce
  configuration; if express is off, fall back to the product `website_url`.
