import json
import os
import sys
from pathlib import Path

import pytest

# Settings are read at import time, so pin a deterministic test env first.
os.environ.setdefault("JWT_SECRET", "test-secret-test-secret-test-secret-32")
os.environ.setdefault("DATABASE_URL", "")          # -> InMemorySaver
os.environ.setdefault("SHOP_BASE", "https://engosoft.com")
os.environ.setdefault("OPENAI_API_KEY", "sk-test")
os.environ.setdefault("ODOO_API_KEY", "odoo-test")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from langgraph.checkpoint.memory import InMemorySaver  # noqa: E402

from app import agent as agent_mod  # noqa: E402
from app import catalog as catalog_mod  # noqa: E402
from app import curriculum as curriculum_mod  # noqa: E402
from app import tools as tools_mod  # noqa: E402

from .fakes import FakeOdoo, ScriptedModel  # noqa: E402


@pytest.fixture(autouse=True)
def unpruned_curriculum():
    """The map is pruned to whatever Odoo publishes, and the fake catalogue
    publishes three courses that are not in it. Each test therefore starts from
    the shipped map; a test that loads the catalogue prunes it as production
    does."""
    curriculum_mod._pruned_to = None
    curriculum_mod._field_words.cache_clear()
    yield
    curriculum_mod._pruned_to = None
    curriculum_mod._field_words.cache_clear()


@pytest.fixture(autouse=True)
def reset_rate_limits():
    """Limiter buckets are module-level, so they leak between tests."""
    from app import main as main_mod
    main_mod._chat_hits.clear()
    main_mod._mint_hits.clear()
    yield


@pytest.fixture
def fake_odoo(monkeypatch):
    """Installs a fake Odoo everywhere it is imported, and clears the snapshot
    so each test rebuilds the catalogue from scratch."""
    od = FakeOdoo()
    monkeypatch.setattr(catalog_mod, "odoo", od)
    monkeypatch.setattr(tools_mod, "odoo", od)
    monkeypatch.setattr(catalog_mod, "_snap", catalog_mod.Snapshot())
    yield od
    monkeypatch.setattr(catalog_mod, "_snap", catalog_mod.Snapshot())


@pytest.fixture
async def loaded_catalog(fake_odoo):
    await catalog_mod.refresh(full=True)
    return catalog_mod.snapshot()


@pytest.fixture
def client_factory(fake_odoo):
    """Builds the ASGI app with a scripted model wired into the real graph."""
    import httpx

    def _factory(script, currency="EGP"):
        model = ScriptedModel(script=script, cursor=0, calls=[])
        graph = agent_mod.build_graph(InMemorySaver(), model=model,
                                      system_prompt="SYS")
        agent_mod.set_graph(graph)
        from app.main import app
        transport = httpx.ASGITransport(app=app)
        return httpx.AsyncClient(transport=transport,
                                 base_url="http://test"), model

    yield _factory
    agent_mod.set_graph(None)


def parse_sse(body: str) -> list[dict]:
    out = []
    for line in body.splitlines():
        if line.startswith("data: "):
            out.append(json.loads(line[6:]))
    return out
