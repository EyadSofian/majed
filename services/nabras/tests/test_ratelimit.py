"""Pacing turns instead of letting OpenAI refuse them.

Production, one conversation, messages seconds apart:

    429 → wait → 429 → wait → 200        turn in=54145ms

The tokens were always going to be rationed at usage tier 1. What made it feel
broken was spending the ration on requests that were thrown away and then
sleeping through a blind backoff. These tests pin the two properties that make
the difference: a turn waits for room it can compute, and turns are admitted in
the order they arrived.
"""
import asyncio
import time

import pytest

from app.ratelimit import TokenBucket


def test_pacing_is_off_until_a_budget_is_set():
    """An account with headroom must pay nothing for this."""
    bucket = TokenBucket(0)
    assert not bucket.enabled


async def test_a_turn_that_fits_is_not_delayed():
    bucket = TokenBucket(60_000)
    assert await bucket.acquire(29_000) < 0.05


async def test_a_turn_the_budget_cannot_cover_yet_waits_for_it():
    """The shape that used to be a 429 and a blind backoff."""
    bucket = TokenBucket(60_000)         # 1,000 tokens per second
    await bucket.acquire(59_800)         # 200 left
    started = time.monotonic()
    await bucket.acquire(1_000)          # 800 short -> ~0.8s
    assert time.monotonic() - started >= 0.5


async def test_waiting_turns_are_admitted_in_order():
    """A queue, not a scramble — the point of holding the lock."""
    bucket = TokenBucket(60_000)
    await bucket.acquire(60_000)         # drain it
    order: list[int] = []

    async def turn(n: int):
        await bucket.acquire(1_000)
        order.append(n)

    await asyncio.gather(*(turn(i) for i in range(5)))
    assert order == [0, 1, 2, 3, 4], order


async def test_a_turn_larger_than_the_whole_budget_still_gets_served():
    """Better a slow answer than a customer who can never be answered."""
    bucket = TokenBucket(1_000)
    await asyncio.wait_for(bucket.acquire(50_000), timeout=5)


async def test_the_budget_refills_over_time_rather_than_in_steps():
    bucket = TokenBucket(60_000)         # 1,000 tokens per second
    await bucket.acquire(60_000)
    await asyncio.sleep(0.2)
    started = time.monotonic()
    await bucket.acquire(150)            # ~200 already refilled
    assert time.monotonic() - started < 0.1
