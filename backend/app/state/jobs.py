"""Job progress registry: a single multiplexed pub-sub channel, keyed by job_id."""

import asyncio
import uuid
from dataclasses import dataclass


@dataclass
class JobEvent:
    job_id: str
    stage: str
    percent: float
    message: str = ""


_subscribers: set[asyncio.Queue] = set()


def new_job_id() -> str:
    return str(uuid.uuid4())


def subscribe() -> "asyncio.Queue[JobEvent]":
    q: asyncio.Queue = asyncio.Queue()
    _subscribers.add(q)
    return q


def unsubscribe(q: "asyncio.Queue[JobEvent]") -> None:
    _subscribers.discard(q)


async def publish(event: JobEvent) -> None:
    for q in list(_subscribers):
        await q.put(event)
