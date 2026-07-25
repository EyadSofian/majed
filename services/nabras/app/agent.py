"""LangChain/LangGraph sales agent with persisted memory.

Uses `langchain.agents.create_agent` (the LangChain 1.x API). The older
`langgraph.prebuilt.create_react_agent` is deprecated since LangGraph 1.0 and
names its model node "agent" instead of "model" — which silently breaks
node-name-based stream filters. `main.py` therefore filters on message *type*,
not node name, so this stays correct under either.
"""
import hashlib
import logging
import re
from contextlib import asynccontextmanager
from typing import Any, Optional

from langchain.agents import create_agent
from langchain_core.messages import HumanMessage

from . import catalog
from .config import get_settings
from .prompts import build_system_prompt
from .tools import TOOLS

log = logging.getLogger("nabras.agent")

_graph = None
_prompt_fingerprint: Optional[str] = None
_model: Any = None

# OpenAI rejects the whole request when a gpt-5 model is given function tools
# together with reasoning on the chat-completions endpoint:
#   "Function tools with reasoning_effort are not supported for gpt-5.6-terra in
#    /v1/chat/completions. To use function tools, use /v1/responses or set
#    reasoning_effort to 'none'."
# Every turn here binds 9 tools, so the flag has to be pinned — and pinned ONLY
# for that family: gpt-4.1 does not know the field and the o-series has no
# "none" level, so sending it there trades one 400 for another.
_GPT5 = re.compile(r"^gpt-5", re.I)
# Parameters worth retrying without: each is a preference, not something the
# agent's behaviour depends on.
_DROPPABLE = ("reasoning_effort", "temperature", "top_p")


def reasoning_effort_for(model: str, configured: str) -> Optional[str]:
    """The value to send as `reasoning_effort`, or None to omit the field."""
    value = (configured or "").strip().lower()
    if not value or value in ("off", "omit", "unset"):
        return None
    return value if _GPT5.match((model or "").strip()) else None


def model_kwargs() -> dict[str, Any]:
    s = get_settings()
    kw: dict[str, Any] = {"model": s.agent_model, "api_key": s.openai_api_key,
                          "streaming": True}
    if s.agent_temperature >= 0:
        kw["temperature"] = s.agent_temperature
    effort = reasoning_effort_for(s.agent_model, s.agent_reasoning_effort)
    if effort:
        kw["reasoning_effort"] = effort
    # Prompt caching applies automatically to the repeated system prompt.
    return kw


def build_model(kw: Optional[dict[str, Any]] = None):
    from langchain_openai import ChatOpenAI
    return ChatOpenAI(**(kw if kw is not None else model_kwargs()))


def _rejected_param(err: Exception) -> Optional[str]:
    """Which request field did OpenAI refuse? None if that is not the problem."""
    body = getattr(err, "body", None)
    param = (body or {}).get("param") if isinstance(body, dict) else None
    if isinstance(param, str) and param:
        return param
    text = str(err)
    if "400" not in text and "invalid_request" not in text:
        return None
    for name in _DROPPABLE:                      # message-only 400s
        if name in text:
            return name
    return None


async def negotiate_model(build=None):
    """Build the model and prove the request shape is accepted before serving.

    A model swap (AGENT_MODEL) can make one sampling field illegal — and the
    failure only shows up on the first customer message, as a 400 the visitor
    sees as silence. One tiny call at boot turns that into a log line and a
    request that works: drop the field OpenAI names and try again.
    """
    build = build or build_model
    kw = model_kwargs()
    dropped: list[str] = []
    model = build(kw)
    for _ in range(len(_DROPPABLE)):
        try:
            await model.bind_tools(TOOLS).ainvoke([HumanMessage(content="ping")])
            if dropped:
                log.warning("model %s: dropped %s so function tools are accepted",
                            kw.get("model"), ", ".join(dropped))
            return model
        except Exception as e:  # noqa: BLE001
            param = _rejected_param(e)
            if not param or param not in kw:
                # Not a request-shape problem (quota, network, key). Serve
                # anyway: the catalogue is still useful and health stays honest.
                log.warning("model probe for %s did not pass: %s",
                            kw.get("model"), str(e)[:300])
                return model
            kw.pop(param)
            dropped.append(param)
            model = build(kw)
    return model


def build_graph(checkpointer: Any, model: Optional[Any] = None,
                system_prompt: Optional[str] = None):
    """Compile the agent. Exposed so tests can inject a fake model/checkpointer."""
    return create_agent(
        model=model if model is not None else build_model(),
        tools=TOOLS,
        system_prompt=system_prompt or build_system_prompt(),
        checkpointer=checkpointer,
    )


def _fingerprint(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def refresh_prompt() -> bool:
    """Recompile only when the catalogue actually changed.

    The system prompt carries the catalogue digest, so it must follow catalogue
    edits — but recompiling on every turn would throw away prompt caching for
    no reason. Rebuilding on a content hash keeps the prompt byte-identical
    across the ~99% of turns where nothing was edited in Odoo.
    """
    global _graph, _prompt_fingerprint
    if _graph is None:
        return False
    prompt = build_system_prompt(catalog.catalog_digest(),
                                 catalog.instructor_digest())
    fp = _fingerprint(prompt)
    if fp == _prompt_fingerprint:
        return False
    _graph = create_agent(model=_model, tools=TOOLS, system_prompt=prompt,
                          checkpointer=_checkpointer)
    _prompt_fingerprint = fp
    log.info("agent prompt rebuilt (catalogue changed) fp=%s", fp)
    return True


_checkpointer: Any = None


@asynccontextmanager
async def lifespan_agent(app=None):
    """Open the checkpointer, warm the catalogue, compile, and keep it fresh.

    With DATABASE_URL set -> Postgres (memory survives restarts).
    Without it -> in-memory (dev only; conversations die with the process).
    """
    global _graph, _model, _checkpointer, _prompt_fingerprint
    import asyncio
    s = get_settings()

    async def _boot(saver):
        global _graph, _model, _checkpointer, _prompt_fingerprint
        try:
            await catalog.refresh(full=True)
        except Exception:  # noqa: BLE001
            log.exception("initial catalogue load failed — starting empty")
        prompt = build_system_prompt(catalog.catalog_digest(),
                                     catalog.instructor_digest())
        _model = await negotiate_model()
        _checkpointer = saver
        _graph = create_agent(model=_model, tools=TOOLS, system_prompt=prompt,
                              checkpointer=saver)
        _prompt_fingerprint = _fingerprint(prompt)

    async def _keep_fresh():
        while True:
            try:
                await asyncio.sleep(s.catalog_refresh_seconds)
                await catalog.refresh(full=False)
                refresh_prompt()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                log.exception("catalogue refresh failed; will retry")

    if s.database_url:
        from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
        async with AsyncPostgresSaver.from_conn_string(s.database_url) as saver:
            await saver.setup()
            await _boot(saver)
            task = asyncio.create_task(_keep_fresh())
            log.info("nabras: up with Postgres memory")
            try:
                yield
            finally:
                task.cancel()
                _graph = None
    else:
        from langgraph.checkpoint.memory import InMemorySaver
        await _boot(InMemorySaver())
        task = asyncio.create_task(_keep_fresh())
        log.warning("nabras: DATABASE_URL unset — in-memory memory (dev only)")
        try:
            yield
        finally:
            task.cancel()
            _graph = None


def set_graph(graph) -> None:
    """Test hook: install a pre-built graph."""
    global _graph
    _graph = graph


def get_graph():
    if _graph is None:
        raise RuntimeError("agent not initialised — call within lifespan")
    return _graph
