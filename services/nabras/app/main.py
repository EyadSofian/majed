import asyncio
from contextlib import suppress
import json
import logging
import time
import uuid
from collections import defaultdict

import jwt
import secrets
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage

from . import catalog
from .agent import get_graph, lifespan_agent
from .config import get_settings
from .logging_setup import configure_logging
from .ratelimit import get_bucket
from .schemas import ChatRequest
from .tools import (ACTIVE_FIELD, CARD_SINK, CHIP_SINK, CURRENCY, DEFER_SINK,
                    HANDOFF_SINK, INSTRUCTOR_SINK, LANG, LEAD_SINK,
                    PACKAGE_SINK, active_field_from_messages)

s = get_settings()
# Before the first log call in this process: without it the root logger has no
# handler, so Python's lastResort writes to stderr (Railway files every line as
# an "error") and drops everything below WARNING.
configure_logging(s.log_level)
log = logging.getLogger("nabras")
SSE_HEARTBEAT_SECONDS = 5.0

if len(s.jwt_secret.encode()) < 32 or s.jwt_secret == "change-me":
    log.warning("nabras: JWT_SECRET is weak — use >=32 random bytes in production")

app = FastAPI(title="Majed — Engosoft AI Advisor", lifespan=lifespan_agent)
app.add_middleware(
    CORSMiddleware,
    allow_origins=s.allowed_origins,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# --- naive in-process rate limits (swap for Redis behind >1 replica) ---------
# Fahym leaves both of these open: anyone can mint unlimited guest tokens and
# then hammer the chat endpoint. We cap minting per IP and chat per token.
_chat_hits: dict[str, list[float]] = defaultdict(list)
_mint_hits: dict[str, list[float]] = defaultdict(list)


def _allow(bucket: dict[str, list[float]], key: str, limit: int, window: float) -> bool:
    now = time.time()
    hits = [t for t in bucket[key] if now - t < window]
    bucket[key] = hits
    if len(hits) >= limit:
        return False
    hits.append(now)
    return True


def _guest_token() -> str:
    now = int(time.time())
    return jwt.encode(
        {"sub": f"guest_{uuid.uuid4()}", "role": "guest",
         "iat": now, "exp": now + s.jwt_ttl_hours * 3600},
        s.jwt_secret, algorithm="HS256")


def _verify(token: str | None) -> dict:
    if not token:
        raise HTTPException(401, "guest token required")
    if token.lower().startswith("bearer "):
        token = token[7:]
    try:
        return jwt.decode(token, s.jwt_secret, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "token expired")
    except Exception:  # noqa: BLE001
        raise HTTPException(401, "invalid token")


def _ev(kind: str, payload: dict) -> str:
    return f"data: {json.dumps({'type': kind, **payload}, ensure_ascii=False)}\n\n"


def _text(content) -> str:
    """AIMessageChunk.content is a str for text models, a list of blocks for
    multimodal ones. Flatten to plain text either way."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            b.get("text", "") for b in content
            if isinstance(b, dict) and b.get("type") == "text")
    return ""


@app.get("/health")
async def health():
    snap = catalog.snapshot()
    return {
        "status": "ok", "service": "nabras", "assistant": "ماجد",
        "memory_backend": "postgres" if s.database_url else "in_memory_with_chatwoot_recovery",
        "crm_writes": s.allow_crm_writes,
        "courses": len(snap.courses),
        "batches": sum(len(v) for v in snap.events_by_course.values()),
        "packages_available": bool((snap.packages or {}).get("available")),
        "packages_webhook_configured": bool(s.packages_webhook_url),
        "packages_count": len((snap.packages or {}).get("packages") or []),
        "packages_source": snap.packages_source,
        "packages_age_seconds": round(time.time() - snap.packages_at, 1) if snap.packages_at else None,
        "catalog_age_seconds": round(time.time() - snap.loaded_at, 1) if snap.loaded_at else None,
    }


@app.post("/api/v1/internal/catalog/packages")
async def ingest_packages(payload: dict, request: Request,
                          x_ingest_token: str | None = Header(default=None)):
    """Receive a package snapshot pushed by n8n.

    Direct `training.package*` reads are primary. This endpoint remains as a
    fallback for a future Odoo permission regression or outage; the chat still
    reads the installed snapshot from memory.
    """
    if not s.ingest_token:
        raise HTTPException(503, "ingest disabled: set INGEST_TOKEN")
    if not x_ingest_token or not secrets.compare_digest(x_ingest_token, s.ingest_token):
        log.warning("rejected package ingest from %s",
                    request.client.host if request.client else "?")
        raise HTTPException(401, "invalid ingest token")
    try:
        counts = catalog.install_packages(payload)
    except ValueError as e:
        raise HTTPException(422, str(e))
    return {"status": "ok", "installed": counts}


@app.post("/api/v1/user/guest-session/create/")
async def guest_session(request: Request):
    ip = (request.client.host if request.client else "unknown")
    if not _allow(_mint_hits, ip, s.guest_mint_per_hour, 3600):
        raise HTTPException(429, "too many guest sessions")
    return {"status": "ok", "data": {"guest_token": _guest_token()}}


@app.post("/api/v1/ai-chat/chat/")
async def chat(req: ChatRequest, request: Request,
               x_guest_token: str | None = Header(default=None),
               authorization: str | None = Header(default=None)):
    claims = _verify(x_guest_token or authorization)
    if not _allow(_chat_hits, claims["sub"], s.guest_rate_per_min, 60):
        raise HTTPException(429, "rate limit")

    graph = get_graph()
    thread = {"configurable": {"thread_id": req.session_id}}
    ctx = req.message
    bits = []
    if req.page_type:
        bits.append(f"page={req.page_type} slug={req.slug or ''}")
    # Goes on the turn, never in the system prompt — that has to stay
    # byte-identical between turns for prompt caching to hold.
    if req.country:
        bits.append(f"country={req.country.strip().upper()}")
    if bits:
        ctx += "\n\n[context] " + " ".join(bits)

    currency = (req.currency or s.default_currency).upper()
    if currency not in s.supported_currencies:
        currency = s.default_currency

    # Titles follow the site the visitor is reading, not a server default.
    lang = catalog.normalize_lang(req.lang or "")
    if lang:
        try:
            await catalog.ensure_language(lang)
        except Exception:  # noqa: BLE001
            log.exception("could not load titles for lang=%s", lang)

    started = time.perf_counter()
    tools_used: list[str] = []

    async def sse():
        # Each sink is a mutable container the tools mutate in place; tools run
        # in child tasks whose context is a copy, so a rebind there is lost.
        cards_tok = CARD_SINK.set([])
        pkgs_tok = PACKAGE_SINK.set([])
        hand_tok = HANDOFF_SINK.set({})
        lead_tok = LEAD_SINK.set({})
        chip_tok = CHIP_SINK.set([])
        cur_tok = CURRENCY.set(currency)
        lang_tok = LANG.set(lang)
        defer_tok = DEFER_SINK.set({})
        instr_tok = INSTRUCTOR_SINK.set([])
        transcript = [item.content for item in (req.history or [])
                      if item.role == "user"] + [req.message]
        field_tok = ACTIVE_FIELD.set(active_field_from_messages(transcript))
        try:
            # Start the HTTP body immediately. This prevents proxies and the
            # bridge from treating a legitimate n8n/tool wait as a dead socket.
            yield _ev("status", {"stage": "thinking"})
            # Wait for budget before spending any of it. The heartbeat is
            # already flowing, so a paced turn looks like thinking rather than
            # a dead socket — which is exactly what a blind SDK backoff looked
            # like from the customer's side.
            waited = await get_bucket().acquire(s.openai_tokens_per_turn)
            if waited > 1.0:
                yield _ev("status", {"stage": "queued",
                                     "waited_ms": int(waited * 1000)})
            # LangGraph/Postgres is the primary conversation memory.  Chatwoot
            # is the durable source of truth for the customer transcript, so a
            # fresh worker can seed an empty thread after a restart or replica
            # change.  Never append this history to a non-empty thread: doing so
            # would duplicate turns and make the model repeat itself.
            input_messages = []
            if req.history:
                try:
                    state = await graph.aget_state(thread)
                    saved = (state.values or {}).get("messages", []) if state else []
                except Exception:  # noqa: BLE001
                    log.exception("could not inspect memory for session=%s", req.session_id)
                    saved = []
                if not saved:
                    for item in req.history:
                        cls = HumanMessage if item.role == "user" else AIMessage
                        input_messages.append(cls(content=item.content))
                    log.info("memory recovery session=%s turns=%d",
                             req.session_id, len(input_messages))
            input_messages.append(HumanMessage(content=ctx))

            stream = graph.astream(
                {"messages": input_messages},
                thread, stream_mode="messages",
            ).__aiter__()
            next_chunk = asyncio.create_task(anext(stream))
            try:
                while True:
                    done, _ = await asyncio.wait(
                        {next_chunk}, timeout=SSE_HEARTBEAT_SECONDS)
                    if not done:
                        yield _ev("ping", {})
                        continue
                    try:
                        chunk, meta = next_chunk.result()
                    except StopAsyncIteration:
                        break

                    # Filter on message TYPE, not node name: LangGraph's
                    # prebuilt calls the node "agent", LangChain's create_agent
                    # calls it "model". Type-based filtering survives both.
                    if isinstance(chunk, AIMessageChunk):
                        for call in (getattr(chunk, "tool_call_chunks", None) or []):
                            name = call.get("name")
                            if name and name not in tools_used:
                                tools_used.append(name)
                        text = _text(chunk.content)
                        if text:
                            yield _ev("token", {"content": text})
                    next_chunk = asyncio.create_task(anext(stream))
            finally:
                if not next_chunk.done():
                    next_chunk.cancel()
                    with suppress(asyncio.CancelledError):
                        await next_chunk

            # "not mine": drop everything from this turn so the bridge can
            # hand the same message to the other bot. Emitted before the cards
            # so a client that stops at `defer` never renders a half answer.
            deferred = DEFER_SINK.get() or {}
            if deferred.get("deferred"):
                yield _ev("defer", {"reason": deferred.get("reason", "")})
                yield _ev("done", {})
                return

            cards = CARD_SINK.get() or []
            if cards:
                yield _ev("cards", {"course_cards": cards, "currency": currency})
            packages = PACKAGE_SINK.get() or []
            if packages:
                yield _ev("packages", {"package_cards": packages,
                                       "currency": currency})
            instructors = INSTRUCTOR_SINK.get() or []
            if instructors:
                yield _ev("instructors", {"instructor_cards": instructors})
            chips = CHIP_SINK.get() or []
            if chips:
                yield _ev("chips", {"chips": chips})
            # The advisor's copy of the capture. Emitted before the handoff so
            # a conversation that captures and then escalates carries both.
            lead = LEAD_SINK.get() or {}
            if lead.get("lead_id"):
                yield _ev("lead", lead)
            handoff = HANDOFF_SINK.get()
            if handoff and handoff.get("requested"):
                # The bridge owns Chatwoot; we only signal.
                yield _ev("handoff", handoff)
            log.info("turn session=%s lang=%s cur=%s tools=[%s] cards=%d "
                     "packages=%d chips=%d%s in=%dms",
                     req.session_id, lang or "-", currency,
                     ",".join(tools_used) or "-", len(cards), len(packages),
                     len(chips),
                     (f" lead={lead['lead_id']}" if lead.get("lead_id") else "")
                     + (f" paced={waited:.1f}s" if waited > 1.0 else ""),
                     int((time.perf_counter() - started) * 1000))
            yield _ev("done", {})
        except Exception as e:  # noqa: BLE001
            log.exception("chat stream failed for session=%s tools=[%s]",
                          req.session_id, ",".join(tools_used) or "-")
            # The class name reaches the bridge log so a failure is diagnosable
            # from one line; the message may carry credentials, so it does not.
            yield _ev("error", {"message": "upstream_error",
                                "detail": type(e).__name__})
        finally:
            CARD_SINK.reset(cards_tok)
            PACKAGE_SINK.reset(pkgs_tok)
            HANDOFF_SINK.reset(hand_tok)
            LEAD_SINK.reset(lead_tok)
            CHIP_SINK.reset(chip_tok)
            CURRENCY.reset(cur_tok)
            LANG.reset(lang_tok)
            DEFER_SINK.reset(defer_tok)
            INSTRUCTOR_SINK.reset(instr_tok)
            ACTIVE_FIELD.reset(field_tok)

    return StreamingResponse(sse(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "Connection": "keep-alive",
                                      "X-Accel-Buffering": "no"})


@app.get("/api/v1/ai-chat/history/{session_id}/")
async def history(session_id: str,
                  x_guest_token: str | None = Header(default=None),
                  authorization: str | None = Header(default=None)):
    _verify(x_guest_token or authorization)
    graph = get_graph()
    state = await graph.aget_state({"configurable": {"thread_id": session_id}})
    msgs = (state.values or {}).get("messages", []) if state else []
    out = [{"role": getattr(m, "type", "?"), "content": m.content}
           for m in msgs if getattr(m, "content", "")]
    return JSONResponse({"status": "ok", "data": out})
