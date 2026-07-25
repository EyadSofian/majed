import json
import os
import sys
from pathlib import Path

import pytest

# Settings are read at import time, so pin a deterministic test env first.
os.environ.setdefault("JWT_SECRET", "test-secret")
os.environ.setdefault("DATABASE_URL", "")          # -> InMemorySaver
os.environ.setdefault("SHOP_BASE", "https://engosoft.com")
os.environ.setdefault("OPENAI_API_KEY", "sk-test")
os.environ.setdefault("PINECONE_API_KEY", "pc-test")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from langgraph.checkpoint.memory import InMemorySaver  # noqa: E402

from app import agent as agent_mod  # noqa: E402
from app import tools as tools_mod  # noqa: E402

from .fakes import FakeOdoo, FakePineconeIndex, ScriptedModel  # noqa: E402


@pytest.fixture(autouse=True)
def reset_rate_limits():
    """Limiter buckets are module-level, so they leak between tests."""
    from app import main as main_mod
    main_mod._chat_hits.clear()
    main_mod._mint_hits.clear()
    yield


@pytest.fixture
def fake_index(monkeypatch):
    idx = FakePineconeIndex()
    monkeypatch.setattr(tools_mod, "_pinecone_index", lambda: idx)

    async def _embed(_text):
        return [0.0] * 8
    monkeypatch.setattr(tools_mod, "_embed", _embed)
    return idx


@pytest.fixture
def fake_odoo(monkeypatch):
    od = FakeOdoo()
    monkeypatch.setattr(tools_mod, "odoo", od)
    return od


@pytest.fixture
def make_app(fake_index, fake_odoo):
    """Builds the ASGI app with a scripted model wired into the real graph."""
    def _make(script):
        model = ScriptedModel(script=script, cursor=0, calls=[])
        graph = agent_mod.build_graph(InMemorySaver(), model=model)
        agent_mod.set_graph(graph)
        from app.main import app
        return app, model
    yield _make
    agent_mod.set_graph(None)


@pytest.fixture
def client_factory(make_app):
    import httpx

    def _factory(script):
        app, model = make_app(script)
        transport = httpx.ASGITransport(app=app)
        return httpx.AsyncClient(transport=transport,
                                 base_url="http://test"), model
    return _factory


def parse_sse(body: str) -> list[dict]:
    out = []
    for line in body.splitlines():
        if line.startswith("data: "):
            out.append(json.loads(line[6:]))
    return out
