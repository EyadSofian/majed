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
from langchain_core.messages import AIMessageChunk, HumanMessage

from . import catalog
from .agent import get_graph, lifespan_agent
from .config import get_settings
from .schemas import ChatRequest
from .tools import CARD_SINK, CURRENCY, HANDOFF_SINK, PACKAGE_SINK

log = logging.getLogger("nabras")
s = get_settings()

if len(s.jwt_secret.encode()) < 32 or s.jwt_secret == "change-me":
    log.warning("nabras: JWT_SECRET is weak — use >=32 random bytes in production")

app = FastAPI(title="نبراس — Engosoft AI Advisor", lifespan=lifespan_agent)
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
        "status": "ok", "service": "nabras",
        "courses": len(snap.courses),
        "batches": sum(len(v) for v in snap.events_by_course.values()),
        "packages_available": bool((snap.packages or {}).get("available")),
        "packages_count": len((snap.packages or {}).get("packages") or []),
        "packages_source": snap.packages_source,
        "packages_age_seconds": round(time.time() - snap.packages_at, 1) if snap.packages_at else None,
        "catalog_age_seconds": round(time.time() - snap.loaded_at, 1) if snap.loaded_at else None,
    }


@app.post("/api/v1/internal/catalog/packages")
async def ingest_packages(payload: dict, request: Request,
                          x_ingest_token: str | None = Header(default=None)):
    """Receive a package snapshot pushed by n8n.

    The bot's Odoo user cannot read `training.package*`; n8n's credential can.
    Rather than proxying every chat request through n8n — an extra hop plus an
    admin credential sitting in a public request path — n8n pushes here on a
    schedule and the chat keeps reading from memory.
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
    if req.page_type:
        ctx += f"\n\n[context] page={req.page_type} slug={req.slug or ''}"

    currency = (req.currency or s.default_currency).upper()
    if currency not in s.supported_currencies:
        currency = s.default_currency

    async def sse():
        # Each sink is a mutable container the tools mutate in place; tools run
        # in child tasks whose context is a copy, so a rebind there is lost.
        cards_tok = CARD_SINK.set([])
        pkgs_tok = PACKAGE_SINK.set([])
        hand_tok = HANDOFF_SINK.set({})
        cur_tok = CURRENCY.set(currency)
        try:
            async for chunk, meta in graph.astream(
                {"messages": [HumanMessage(content=ctx)]},
                thread, stream_mode="messages",
            ):
                # Filter on message TYPE, not node name: LangGraph's prebuilt
                # calls the node "agent", LangChain's create_agent calls it
                # "model". Type-based filtering survives both.
                if not isinstance(chunk, AIMessageChunk):
                    continue
                text = _text(chunk.content)
                if text:
                    yield _ev("token", {"content": text})

            cards = CARD_SINK.get() or []
            if cards:
                yield _ev("cards", {"course_cards": cards, "currency": currency})
            packages = PACKAGE_SINK.get() or []
            if packages:
                yield _ev("packages", {"package_cards": packages,
                                       "currency": currency})
            handoff = HANDOFF_SINK.get()
            if handoff and handoff.get("requested"):
                # The bridge owns Chatwoot; we only signal.
                yield _ev("handoff", handoff)
            yield _ev("done", {})
        except Exception:  # noqa: BLE001
            log.exception("chat stream failed for session=%s", req.session_id)
            yield _ev("error", {"message": "upstream_error"})
        finally:
            CARD_SINK.reset(cards_tok)
            PACKAGE_SINK.reset(pkgs_tok)
            HANDOFF_SINK.reset(hand_tok)
            CURRENCY.reset(cur_tok)

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
