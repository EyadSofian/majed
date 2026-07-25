"""LangChain/LangGraph sales agent with persisted memory.

Uses `langchain.agents.create_agent` (the LangChain 1.x API). The older
`langgraph.prebuilt.create_react_agent` is deprecated since LangGraph 1.0 and
names its model node "agent" instead of "model" — which silently breaks
node-name-based stream filters. `main.py` therefore filters on message *type*,
not node name, so this stays correct under either.
"""
import hashlib
import logging
from contextlib import asynccontextmanager
from typing import Any, Optional

from langchain.agents import create_agent

from . import catalog
from .config import get_settings
from .prompts import build_system_prompt
from .tools import TOOLS

log = logging.getLogger("nabras.agent")

_graph = None
_prompt_fingerprint: Optional[str] = None
_model: Any = None


def build_model():
    from langchain_openai import ChatOpenAI
    s = get_settings()
    kw: dict[str, Any] = {"model": s.agent_model, "api_key": s.openai_api_key,
                          "streaming": True}
    if s.agent_temperature >= 0:
        kw["temperature"] = s.agent_temperature
    # Prompt caching applies automatically to the repeated system prompt.
    return ChatOpenAI(**kw)


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
    prompt = build_system_prompt(catalog.catalog_digest())
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
        prompt = build_system_prompt(catalog.catalog_digest())
        _model = build_model()
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
