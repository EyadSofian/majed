"""Test doubles: a scriptable streaming/tool-calling chat model, a fake
Pinecone index, and a fake Odoo. No network, no API keys."""
from typing import Any, Iterator, Optional

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult


class ScriptedModel(BaseChatModel):
    """Replays a script of turns.

    Each turn is either ``{"tool": name, "args": {...}}`` or
    ``{"text": "..."}``. Text turns stream word-by-word so we exercise the real
    token path. `calls` records the prompts the agent sent, for assertions.
    """

    script: list = []
    cursor: int = 0
    calls: list = []

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def bind_tools(self, tools: Any, **kw: Any) -> "ScriptedModel":
        return self

    def _next(self) -> dict:
        if self.cursor >= len(self.script):
            return {"text": "تمام."}
        step = self.script[self.cursor]
        self.cursor += 1
        return step

    def _generate(self, messages, stop=None, run_manager=None, **kw) -> ChatResult:
        self.calls.append(list(messages))
        step = self._next()
        if "tool" in step:
            msg = AIMessage(content="", tool_calls=[{
                "name": step["tool"], "args": step.get("args", {}),
                "id": f"call_{self.cursor}"}])
        else:
            msg = AIMessage(content=step["text"])
        return ChatResult(generations=[ChatGeneration(message=msg)])

    def _stream(self, messages, stop=None, run_manager=None,
                **kw) -> Iterator[ChatGenerationChunk]:
        self.calls.append(list(messages))
        step = self._next()
        if "tool" in step:
            yield ChatGenerationChunk(message=AIMessageChunk(
                content="", tool_calls=[{
                    "name": step["tool"], "args": step.get("args", {}),
                    "id": f"call_{self.cursor}"}]))
            return
        words = step["text"].split(" ")
        for i, w in enumerate(words):
            piece = w if i == len(words) - 1 else w + " "
            yield ChatGenerationChunk(message=AIMessageChunk(content=piece))


# --------------------------------------------------------------------------
CATALOG = [
    {"course_id": 101, "title": "Power BI Data Analysis",
     "slug": "power-bi-data-analysis", "rating": 4.8,
     "price_display": "$120", "summary": "Dashboards, DAX, modeling.",
     "thumbnail_url": "https://engosoft.com/img/pbi.png"},
    {"course_id": 102, "title": "PMP Exam Prep",
     "slug": "pmp-exam-prep", "rating": 4.9,
     "price_display": "$350", "summary": "35 PDUs, PMBOK 7."},
    {"course_id": 103, "title": "Six Sigma Green Belt",
     "slug": "six-sigma-green-belt", "rating": 4.6,
     "price_display": "$200", "summary": "DMAIC, MINITAB."},
]


class FakePineconeIndex:
    """Mimics `Index.query` — returns the OpenAPI-ish object shape."""

    def __init__(self, rows: Optional[list] = None, fail: bool = False):
        self.rows = rows if rows is not None else CATALOG
        self.fail = fail
        self.queries: list = []

    def query(self, vector=None, top_k=5, namespace=None,
              include_metadata=True, **kw):
        if self.fail:
            raise RuntimeError("pinecone down")
        self.queries.append({"top_k": top_k, "namespace": namespace})
        matches = [type("M", (), {"id": str(r["course_id"]), "score": 0.9,
                                  "metadata": dict(r)})()
                   for r in self.rows[:top_k]]
        return type("R", (), {"matches": matches})()


class FakeOdoo:
    """Stands in for the JSON-RPC client."""

    def __init__(self, fail: bool = False):
        self.fail = fail
        self.leads: list = []

    async def read_courses(self, ids, fields):
        if self.fail:
            raise RuntimeError("odoo timeout")
        out = []
        for r in CATALOG:
            if r["course_id"] in ids:
                out.append({"name": r["title"],
                            "list_price": float(r["price_display"].strip("$")),
                            "currency_id": [1, "USD"], "sale_ok": True,
                            "website_url": f"/courses/{r['slug']}"})
        return out

    async def product_variant_id(self, template_id):
        if self.fail:
            raise RuntimeError("odoo timeout")
        return template_id + 9000 if any(
            c["course_id"] == template_id for c in CATALOG) else None

    async def create_lead(self, payload):
        if self.fail:
            raise RuntimeError("odoo timeout")
        self.leads.append(payload)
        return 5000 + len(self.leads)
