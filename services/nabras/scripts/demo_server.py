"""Runs the REAL FastAPI app against a fake Odoo and a scripted model.

No API keys, no network. Used by `demo_trace.py` to prove the wire behaviour
(SSE ordering, live pricing, batches, packages, handoff) end to end.

    python scripts/demo_server.py         # serves on :8099
"""
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

os.environ.setdefault("JWT_SECRET", "demo-secret-demo-secret-demo-secret-32")
os.environ.setdefault("DATABASE_URL", "")
os.environ.setdefault("SHOP_BASE", "https://engosoft.com")
os.environ.setdefault("CORS_ORIGINS", "*")
os.environ.setdefault("ODOO_API_KEY", "demo")

from langgraph.checkpoint.memory import InMemorySaver  # noqa: E402

from app import agent as agent_mod  # noqa: E402
from app import catalog as catalog_mod  # noqa: E402
from app import tools as tools_mod  # noqa: E402
from tests.fakes import FakeOdoo, ScriptedModel  # noqa: E402


class TurnScriptedModel(ScriptedModel):
    """Picks its step from (human turns, tool results) so a multi-turn
    conversation replays deterministically and can never loop."""

    turns: dict = {}

    def _plan(self, messages):
        n_human = sum(1 for m in messages if getattr(m, "type", "") == "human")
        n_tool = sum(1 for m in messages if getattr(m, "type", "") == "tool")
        return self.turns.get((n_human, n_tool), {"text": "تمام، تحت أمرك."})

    def _generate(self, messages, stop=None, run_manager=None, **kw):
        from langchain_core.messages import AIMessage
        from langchain_core.outputs import ChatGeneration, ChatResult
        self.calls.append(list(messages))
        step = self._plan(messages)
        if "tool" in step:
            msg = AIMessage(content="", tool_calls=[{
                "name": step["tool"], "args": step.get("args", {}),
                "id": f"c{len(self.calls)}"}])
        else:
            msg = AIMessage(content=step["text"])
        return ChatResult(generations=[ChatGeneration(message=msg)])

    def _stream(self, messages, stop=None, run_manager=None, **kw):
        import time

        from langchain_core.messages import AIMessageChunk
        from langchain_core.outputs import ChatGenerationChunk
        self.calls.append(list(messages))
        step = self._plan(messages)
        if "tool" in step:
            yield ChatGenerationChunk(message=AIMessageChunk(
                content="", tool_calls=[{
                    "name": step["tool"], "args": step.get("args", {}),
                    "id": f"c{len(self.calls)}"}]))
            return
        for i, w in enumerate(step["text"].split(" ")):
            time.sleep(0.03)      # simulated per-token generation latency
            yield ChatGenerationChunk(message=AIMessageChunk(content=w + " "))


SCRIPT = {
    # turn 1 — package first, then courses
    (1, 0): {"tool": "search_packages", "args": {"query": "interior design"}},
    (1, 1): {"tool": "search_courses", "args": {"query": "BIM navisworks revit"}},
    (1, 2): {"text": "في مسار كامل للتصميم الداخلي، وكمان كورسات مفردة في BIM. "
                     "المسار أوفر لو ناوي تكمّل المجال."},
    # turn 2 — price objection, answered with the live pricelist
    (2, 2): {"tool": "get_price", "args": {"course_id": 2107}},
    (2, 3): {"text": "Navisworks MEP بـ 4,815 جنيه. أرخص من المسار الكامل "
                     "وبيديك مهارة التنسيق كاملة."},
    # turn 3 — dates and seats
    (3, 3): {"tool": "get_upcoming_batches", "args": {"course_id": 2107}},
    (3, 4): {"text": "الدفعة الجاية 20 أغسطس بتوقيت الرياض، وفاضل 3 مقاعد بس."},
    # turn 4 — close
    (4, 4): {"tool": "build_checkout_link", "args": {"course_id": 2107}},
    (4, 5): {"text": "اضغط زر الشراء في الكارت وهيوديك على الدفع على طول."},
    # turn 5 — hesitation -> lead + human handoff
    (5, 5): {"tool": "create_lead", "args": {
        "name": "أحمد", "phone": "01000000000", "course_interest": "Navisworks MEP",
        "notes": "متردد بسبب السعر"}},
    (5, 6): {"tool": "request_handoff", "args": {
        "summary": "مهندس مهتم بـ Navisworks MEP، متردد في السعر، اتسجل كـlead",
        "reason": "price_objection"}},
    (5, 7): {"text": "سجّلت بياناتك وهوصلك بزميل من فريق المبيعات دلوقتي."},
}


def build():
    od = FakeOdoo()
    catalog_mod.odoo = od
    tools_mod.odoo = od
    model = TurnScriptedModel(script=[], cursor=0, calls=[], turns=SCRIPT)
    agent_mod.set_graph(agent_mod.build_graph(
        InMemorySaver(), model=model, system_prompt="SYS"))
    return od


ODOO = build()

from app.main import app  # noqa: E402


@asynccontextmanager
async def _demo_lifespan(_app):
    """Replaces the real lifespan: warms the catalogue from the fake Odoo and
    keeps the scripted graph instead of constructing a live ChatOpenAI."""
    await catalog_mod.refresh(full=True)
    yield


app.router.lifespan_context = _demo_lifespan

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8099, log_level="warning")
