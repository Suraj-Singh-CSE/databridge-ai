import pytest

from app.llm.pacing import SlidingWindowLimiter


class FakeTime:
    """A clock that only moves when the limiter sleeps."""

    def __init__(self) -> None:
        self.now = 1000.0
        self.sleeps: list[float] = []

    def clock(self) -> float:
        return self.now

    async def sleep(self, delay: float) -> None:
        self.sleeps.append(delay)
        self.now += delay


def make(max_requests: int) -> tuple[SlidingWindowLimiter, FakeTime]:
    time = FakeTime()
    return SlidingWindowLimiter(max_requests, clock=time.clock, sleep=time.sleep), time


async def test_allows_max_requests_per_window_without_waiting() -> None:
    limiter, time = make(3)

    waits = [await limiter.acquire() for _ in range(3)]

    assert waits == [0, 0, 0]
    assert time.sleeps == []


async def test_waits_until_the_oldest_request_leaves_the_window() -> None:
    limiter, time = make(2)
    await limiter.acquire()
    time.now += 10
    await limiter.acquire()
    time.now += 5

    waited = await limiter.acquire()  # first slot frees 60 s after it was taken

    assert waited == pytest.approx(45)
    assert time.sleeps == [pytest.approx(45)]
    assert await limiter.acquire() == pytest.approx(10)  # then the second one, 10 s later


async def test_slots_free_up_as_time_passes() -> None:
    limiter, time = make(1)
    await limiter.acquire()
    time.now += 60

    assert await limiter.acquire() == 0


async def test_zero_turns_pacing_off() -> None:
    limiter, time = make(0)

    waits = [await limiter.acquire() for _ in range(100)]

    assert set(waits) == {0}
    assert time.sleeps == []


def test_negative_limit_is_rejected() -> None:
    with pytest.raises(ValueError, match="max_requests"):
        SlidingWindowLimiter(-1)
