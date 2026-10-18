"""Per-bot installation flags; missing values remain unknown."""

import asyncio
import time
from dataclasses import dataclass, field

from aiogram import Bot


@dataclass
class _Cache:
    session: object
    value: dict[str, bool] = field(default_factory=dict)
    expires: float = 0
    generation: int = 0
    pending: asyncio.Task | None = None


def _cache(bot: Bot) -> _Cache:
    value = bot.__dict__.get("_lo_capabilities_cache")
    # Bot equality compares token hashes, so WeakKeyDictionary would mix sessions/servers.
    if value is None or value.session is not bot.session:
        value = bot.__dict__["_lo_capabilities_cache"] = _Cache(bot.session)
    return value


def invalidate_capabilities(bot: Bot) -> None:
    """Fence older getMe responses after an explicit feature refusal."""
    cache = _cache(bot)
    cache.generation += 1
    cache.expires = 0
    cache.pending = None


async def capabilities(bot: Bot, *, refresh: bool = False) -> dict[str, bool]:
    """Read getMe.capabilities, coalescing reads and caching flags for five minutes."""
    cache = _cache(bot)
    if not refresh and cache.expires > time.monotonic():
        return cache.value.copy()
    if refresh or cache.pending is None:
        cache.generation += 1
        generation = cache.generation

        async def fetch():
            try:
                identity = await bot.get_me()
                raw = getattr(identity, "capabilities", None)
                value = (
                    {k: v for k, v in raw.items() if isinstance(k, str) and type(v) is bool}
                    if isinstance(raw, dict)
                    else {}
                )
                if cache.generation == generation:
                    cache.value, cache.expires = value, time.monotonic() + 300
                return value
            finally:
                if cache.generation == generation:
                    cache.pending = None

        cache.pending = asyncio.create_task(fetch())
    pending = cache.pending
    assert pending is not None
    return (await asyncio.shield(pending)).copy()
