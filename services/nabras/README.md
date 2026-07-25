# ماجد — Engosoft AI Course Advisor  ·  service codename `nabras`

> **One assistant, one name.** The visitor only ever meets **ماجد**. `nabras` is
> the internal name of this service — the directory, the module, the logs. It
> must never appear in a reply, a card, a lead or anything else a customer can
> read: a second name would make the site look like it runs two different bots.
> This service does not replace Majed, it gives Majed selling skills.

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
| **A package has no single price** — it is a recorded track, plus an online and an onsite figure for *every* cohort | Interior Design: 12,001 recorded · 15,000 online · 32,004–45,475 onsite depending on the cohort. Same shape as a course, not one number. |
| Groups have `is_available_for_sale` / `sale_status` (`active` \| `started` \| `no_events`) | A `started` group is already running; selling a seat in it sells a course that began. |
| One package is `website_published: false`, and groups reference packages that are not published | Both must be filtered, and the second must not crash the join. |

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
| `search_packages` | memory | Multi-course tracks: correct price + `price_basis`, levels, contents, next sellable cohort. |
| `build_checkout_link` | Odoo | Express add-to-cart → checkout, attached to the card. |
| `create_lead` | Odoo | `crm.lead` for the sales advisor (`user_id=2`). |
| `request_handoff` | — | Signals the bridge. Does not touch Chatwoot. |

---

## 5. Trialling it on demo.engosoft.com

Nothing here needs a custom domain. Deploy it as a **second Railway service**
next to `majed` and use the free URL Railway hands out (the existing bot already
runs on `majed-production-dd41.up.railway.app`); the widget only needs a URL, not
a domain.

Reads and writes are configured separately on purpose:

| Variable | Trial value | Why |
|---|---|---|
| `ODOO_URL` | `https://engosoft.com` | The catalogue lives in production. Reading it is safe. |
| `SHOP_BASE` | `https://demo.engosoft.com` | Where course links, images and **checkout** point. Keeps test carts off the live shop. |
| `ALLOW_CRM_WRITES` | `false` | `create_lead` is simulated. No test leads in the live CRM. |
| `CORS_ORIGINS` | `https://demo.engosoft.com` | Only the demo site may call it. |

`GET /health` echoes `crm_writes` so you can see at a glance which mode is live.

> **One thing to check:** the checkout link is built from the *production*
> product id. If demo is a copy of the production database the link resolves; if
> demo has its own catalogue the link will 404 — safe, but you will not be able
> to walk the last step. If demo runs its own Odoo, point `ODOO_URL` at demo too
> and everything stays internally consistent (with demo data).

Going live is then three variables: `SHOP_BASE` back to `engosoft.com`,
`ALLOW_CRM_WRITES=true`, and the real origin in `CORS_ORIGINS`.

---

## 6. Run

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

## 7. Verified behaviour (last run)

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

### Package pricing is the sharpest edge in this service

A package is priced exactly like a course: a delivery mode times a cohort. The
formula was derived from the live data and verified exactly on all six
discounted packages:

```
recorded          = total_price          × (1 − discount            /100)
attendance_online = group.online_total   × (1 − attendee_online_disc /100)
attendance_onsite = group.onsite_total   × (1 − attendee_onsite_disc /100)
```

`final_price` is just the computed recorded figure — `23,750 × (1−49.47%) =
12,000.875`, matching to the cent on every package. Applying the same shape to
the Interior Design track:

| Option | List | Discount | Price |
|---|---|---|---|
| Recorded track | 23,750 | 49.47% | **12,001** |
| Online — July cohort | 31,440 | 52.29% | **15,000** |
| Onsite — July morning | 55,000 | 41.81% | **32,004** |
| Onsite — July evening | 58,000 | 41.81% | **33,750** |
| Onsite — August evening | 78,150 | 41.81% | **45,475** |

`_price_options()` returns all of them; `price_from_display` is only a headline.
The prompt makes the agent ask *mode, then cohort* before quoting, and forbids
merging or cross-comparing two bases. Cohorts whose `sale_status` is `started`
are excluded — selling a seat there sells a course that already began.

This is also why the previous Majed prompt said "never state a price, send the
URL": without the mode-and-cohort split there is no single correct number.

> **Still unknown:** whether a trainee can buy *part* of a package. Not modelled.

### Getting package data in without the permission grant

The bot's Odoo user cannot read `training.package*`; n8n's credential can. So
n8n **pushes** a snapshot instead of the bot pulling through it:

```
n8n (every 20 min) ──► POST /api/v1/internal/catalog/packages   [X-Ingest-Token]
                        └─► held in memory, read by search_packages
```

`sync_packages.n8n.json` is the workflow — import it, then set `INGEST_TOKEN`
in its Config node to the same value as the service env var (`NABRAS_URL`
already points at the deployed service). It reads packages, levels, recorded
lines, attendee lines, groups and outcomes in parallel, keeps only published
rows belonging to published packages, refuses to push an empty snapshot, and
emails ops if the push itself fails — a stale catalogue is otherwise silent.

Generate the token with `openssl rand -hex 32`; it is the only thing standing
between the internet and the prices this bot quotes.

Why push and not proxy: a per-request proxy would add a hop to every chat turn
and place an admin-rights credential in the request path of a public bot. This
way the chat still reads from memory and never calls out.

A denied Odoo read can no longer erase pushed data — including on a full
rebuild, where the fresh snapshot inherits it (`packages_source`). `GET /health`
reports `packages_source`, `packages_count` and `packages_age_seconds`.

This is a bridge, not the destination: once the bot user has eLearning/Manager +
Operation Group, it reads packages directly and the workflow can be switched off.

### Course names follow the visitor, not the server

Odoo serves translatable fields in the API *user's* language, and the bot's user
reads English — so the assistant would answer "Light Current Systems Design"
while the page beside it says «تصميم أنظمة التيار الخفيف»: two names for one
product, in one screen.

So the title is resolved per visitor:

```
Odoo website  ──shop.lang──►  /ai_webhook/user_context
                                     │  (fallback: the widget's <html lang>)
                                     ▼
                              bridge resolveLang()  ──lang──►  POST /chat
                                                                  │
                                             titles for that language, loaded
                                             once and cached with the catalogue
```

Loading is bounded and lazy: the first visitor in a language costs one read of
75 rows, everyone after reads from memory, and at most `MAX_LANGS` languages are
held. Titles are re-read for every language in play whenever the catalogue
refreshes, so a rename in Odoo shows up in all of them. Every language's title
goes into the search index, so "navisworks" and «تنسيق أنظمة الميكانيكا» find
the same course. A language Odoo has nothing for falls back to `ODOO_LANG`
(default `ar_001`) and then to the raw name — a missing translation never blanks
a title.

`ODOO_LANG` only sets that fallback. If Arabic titles come back English, the
code is wrong for this database: try `ar_001` / `ar_EG` / `ar_SA`.

### "Not mine" — deferring to the other bot

The router is a per-*conversation* switch: once نبراس is enabled for a visitor,
it answers every message and Botpress is never consulted. That is what makes
rollback a single env var — but it also means a question with no tool behind it
gets improvised. It did exactly that once, answering "do you offer instalments?"
with valU and Tamara, neither of which anyone had verified.

Two changes, because either alone is not enough:

* `get_payment_options` reads `payment.provider` and returns **only** providers
  in `enabled` state — a provider left in `test` is not something a customer can
  pay with. The prompt forbids naming any instalment company that did not come
  back from it.
* `defer_to_bot(reason)` lets the agent say *this is not mine*. The turn's text
  and cards are discarded, the stream carries a `defer` event, the router
  returns `false`, and Botpress answers **that same message** from its knowledge
  base. The customer sees one assistant that simply knew the answer.

Deferral is for questions this service cannot prove: payment and instalment
terms, refunds, invoices, corporate deals, an existing order, certificate
equivalence, careers. It is not an escape hatch for course questions — those
have tools, and the tools are the answer.

## 8. Models

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

## 9. Open item — package permissions

`training.package` and its four related models need groups the bot's Odoo user
(`uid 15577`) does not have. Until they are granted, `search_packages` returns
empty and the chat continues normally — packages are simply never offered, which
costs the highest-value sale in the catalogue (70 of 85 upcoming batches belong
to one).

The package data used to build this was read through n8n, whose Odoo credential
*does* have the rights — which confirms the gap is the bot user specifically,
not the models. Routing the bot's package reads through n8n would work but is
not recommended: it adds a hop to every request and puts an admin-rights
credential in the request path of a public chatbot.

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
