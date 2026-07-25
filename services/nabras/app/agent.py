"""LangChain/LangGraph sales agent with persisted memory.

Uses `langchain.agents.create_agent` (the LangChain 1.x API). The older
`langgraph.prebuilt.create_react_agent` is deprecated since LangGraph 1.0 and
also names its model node "agent" instead of "model" — which silently breaks
node-name-based stream filters. `main.py` therefore filters on message *type*,
not node name, so this stays correct across both.

Streaming is driven from main.py via `graph.astream(..., stream_mode="messages")`.
"""
import logging
from contextlib import asynccontextmanager
from typing import Any, Optional

from langchain.agents import create_agent

from .config import get_settings
from .prompts import SYSTEM_PROMPT
from .tools import TOOLS

log = logging.getLogger("nabras.agent")

_graph = None


def build_model():
    from langchain_openai import ChatOpenAI
    s = get_settings()
    kw: dict[str, Any] = {"model": s.agent_model, "api_key": s.openai_api_key,
                          "streaming": True}
    if s.agent_temperature >= 0:
        kw["temperature"] = s.agent_temperature
    # Prompt caching applies automatically to the repeated system prompt.
    return ChatOpenAI(**kw)


def build_graph(checkpointer: Any, model: Optional[Any] = None):
    """Compile the agent. Exposed so tests can inject a fake model/checkpointer."""
    return create_agent(
        model=model if model is not None else build_model(),
        tools=TOOLS,
        system_prompt=SYSTEM_PROMPT,
        checkpointer=checkpointer,
    )


@asynccontextmanager
async def lifespan_agent(app=None):
    """Open the checkpointer for the app lifetime and compile the graph.

    With DATABASE_URL set -> Postgres (memory survives restarts).
    Without it -> in-memory (dev only; conversations die with the process).
    """
    global _graph
    s = get_settings()
    if s.database_url:
        from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
        async with AsyncPostgresSaver.from_conn_string(s.database_url) as saver:
            await saver.setup()
            _graph = build_graph(saver)
            log.info("nabras: agent up with Postgres memory")
            try:
                yield
            finally:
                _graph = None
    else:
        from langgraph.checkpoint.memory import InMemorySaver
        _graph = build_graph(InMemorySaver())
        log.warning("nabras: DATABASE_URL unset — using in-memory memory (dev only)")
        try:
            yield
        finally:
            _graph = None


def set_graph(graph) -> None:
    """Test hook: install a pre-built graph."""
    global _graph
    _graph = graph


def get_graph():
    if _graph is None:
        raise RuntimeError("agent not initialised — call within lifespan")
    return _graph
