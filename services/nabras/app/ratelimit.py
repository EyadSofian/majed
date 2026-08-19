"""Pace our own calls so OpenAI does not have to refuse them.

At usage tier 1 the account's tokens-per-minute budget is smaller than what a
few consecutive turns cost, and the shape of the failure is worse than the
limit itself. Production, one conversation, messages seconds apart:

    429 → wait → 429 → wait → 200        turn in=54145ms

Nothing was dropped; the customer simply watched a dead widget for the better
part of a minute while the SDK retried with a growing backoff. The tokens were
always going to be rationed — what made it feel broken was spending the ration
on requests that were thrown away, then sleeping through a blind backoff.

A bucket refilled continuously at `tokens_per_minute` fixes the shape: a turn
waits for room it can compute, in the order it arrived, and then goes through.
The same budget, spent on requests that succeed.

Off unless TPM is configured, so an account with headroom pays nothing for it.
"""
import asyncio
import logging
import time
from typing import Optional

log = logging.getLogger("nabras.ratelimit")


class TokenBucket:
    """Continuously-refilled budget, handed out first-come-first-served.

    The lock is what makes it a queue rather than a scramble: without it ten
    waiters wake together, each re-check the same empty bucket, and the one
    that happened to ask first is not the one that gets through.
    """

    def __init__(self, tokens_per_minute: float, burst: Optional[float] = None):
        self.rate = max(0.0, float(tokens_per_minute)) / 60.0     # per second
        # One turn has to fit, or it could never be admitted at all.
        self.capacity = float(burst if burst is not None
                              else max(tokens_per_minute, 1.0))
        self._available = self.capacity
        self._updated = time.monotonic()
        self._lock: Optional[asyncio.Lock] = None

    @property
    def enabled(self) -> bool:
        return self.rate > 0

    def _refill(self, now: float) -> None:
        self._available = min(self.capacity,
                              self._available + (now - self._updated) * self.rate)
        self._updated = now

    async def acquire(self, cost: float) -> float:
        """Wait until *cost* fits, then spend it. Returns the seconds waited."""
        if not self.enabled or cost <= 0:
            return 0.0
        if self._lock is None:
            self._lock = asyncio.Lock()
        started = time.monotonic()
        # A cost above the whole bucket would wait forever; charge it the most
        # the bucket can hold instead of refusing a customer their answer.
        cost = min(float(cost), self.capacity)
        async with self._lock:
            while True:
                now = time.monotonic()
                self._refill(now)
                if self._available >= cost:
                    self._available -= cost
                    waited = now - started
                    if waited > 0.5:
                        log.info("paced %.0f tokens: waited %.1fs for budget",
                                 cost, waited)
                    return waited
                await asyncio.sleep(min((cost - self._available) / self.rate, 5.0))


_bucket: Optional[TokenBucket] = None


def get_bucket() -> TokenBucket:
    global _bucket
    if _bucket is None:
        from .config import get_settings
        s = get_settings()
        _bucket = TokenBucket(s.openai_tpm_budget)
        if _bucket.enabled:
            log.info("pacing OpenAI calls at %s tokens/min", s.openai_tpm_budget)
    return _bucket


def reset_for_tests() -> None:
    global _bucket
    _bucket = None
