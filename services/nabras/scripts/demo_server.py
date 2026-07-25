"""Runs the REAL FastAPI app against fake Pinecone/Odoo and a scripted model.

No API keys, no network. Used by `demo_trace.py` to prove the wire behaviour
(SSE ordering, card payloads, memory) end to end.

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

from langgraph.checkpoint.memory import InMemorySaver  # noqa: E402

from app import agent as agent_mod  # noqa: E402
from app import tools as tools_mod  # noqa: E402
from tests.fakes import FakeOdoo, FakePineconeIndex, ScriptedModel  # noqa: E402


class TurnScriptedModel(ScriptedModel):
    """Picks its script from the number of human turns seen so far, so a
    multi-turn conversation replays sensibly instead of running off the end."""

    turns: dict = {}

    def _next(self):
        return {"text": "تمام."}

    def _plan(self, messages):
        # Keyed by (human turns so far, tool results so far) — deterministic and
        # loop-free: every tool result advances the key.
        n_human = sum(1 for m in messages if getattr(m, "type", "") == "human")
        n_tool = sum(1 for m in messages if getattr(m, "type", "") == "tool")
        return self.turns.get((n_human, n_tool), {"text": "تمام، تحت أمرك."})

    def _generate(self, messages, stop=None, run_manager=None, **kw):
        self.calls.append(list(messages))
        from langchain_core.messages import AIMessage
        from langchain_core.outputs import ChatGeneration, ChatResult
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
        words = step["text"].split(" ")
        for i, w in enumerate(words):
            time.sleep(0.03)      # simulated per-token generation latency
            yield ChatGenerationChunk(
                message=AIMessageChunk(content=w if i == len(words) - 1 else w + " "))


SCRIPT = {
    # (human turns, tool results so far) -> next step
    # ---- turn 1: discover + recommend
    (1, 0): {"tool": "search_courses", "args": {"query": "data analysis power bi"}},
    (1, 1): {"text": "أنصحك تبدأ بـ Power BI Data Analysis — عملي وبيوصلك لداشبورد "
                     "شغال بسرعة. لو هدفك شهادة إدارة، PMP هو المسار."},
    # ---- turn 2: objection (price) — answered from memory, no tool call
    (2, 1): {"text": "أرخص واحد فيهم Power BI بـ $120، و Six Sigma بـ $200. "
                     "الفرق إن Power BI أسرع في العائد العملي."},
    # ---- turn 3: close — live price, then checkout link
    (3, 1): {"tool": "get_course_live", "args": {"course_id": 101}},
    (3, 2): {"tool": "build_checkout_link", "args": {"course_id": 101}},
    (3, 3): {"text": "السعر الحيّ دلوقتي $120 والكورس متاح. اضغط زر الشراء في الكارت "
                     "وهيوديك على الدفع على طول."},
    # ---- turn 4: hesitation -> capture lead
    (4, 3): {"tool": "create_lead", "args": {
        "name": "أحمد", "phone": "01000000000", "course_interest": "Power BI",
        "notes": "متردد بسبب السعر"}},
    (4, 4): {"text": "سجّلت بياناتك يا أحمد ومستشار المبيعات هيتواصل معاك النهاردة."},
}


def build():
    idx = FakePineconeIndex()
    od = FakeOdoo()
    tools_mod._pinecone_index = lambda: idx

    async def _embed(_t):
        return [0.0] * 8
    tools_mod._embed = _embed
    tools_mod.odoo = od

    model = TurnScriptedModel(script=[], cursor=0, calls=[], turns=SCRIPT)
    agent_mod.set_graph(agent_mod.build_graph(InMemorySaver(), model=model))
    return od


ODOO = build()

from app.main import app  # noqa: E402


@asynccontextmanager
async def _demo_lifespan(_app):
    """Replaces the real lifespan: keeps the scripted graph installed by
    build() instead of constructing a live ChatOpenAI client."""
    yield


app.router.lifespan_context = _demo_lifespan

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8099, log_level="warning")
