"""Tests for dofek_ml.worker -- BullMQ training export worker."""

from __future__ import annotations

import re
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from dofek_ml.export import POSTGRES_METRIC_STREAM_EXPORT_RETIRED_MESSAGE
from dofek_ml.worker import (
    IDLE_TIMEOUT_SECONDS,
    LOCK_DURATION_MS,
    MAX_STALLED_COUNT,
    STALLED_INTERVAL_MS,
    parse_redis_url,
    process_training_export,
)


class TestParseRedisUrl:
    def test_simple_url(self) -> None:
        result = parse_redis_url("redis://localhost:6379")
        assert result == {"host": "localhost", "port": 6379}

    def test_url_with_password(self) -> None:
        result = parse_redis_url("redis://:secret@myhost:6380")
        assert result == {"host": "myhost", "port": 6380, "password": "secret"}

    def test_default_port(self) -> None:
        result = parse_redis_url("redis://myhost")
        assert result == {"host": "myhost", "port": 6379}


class TestConstants:
    def test_lock_duration_matches_shared_queue_config(self) -> None:
        """Lock duration must match the shared queue config for training exports."""
        assert LOCK_DURATION_MS == 600_000

    def test_stalled_interval_is_half_lock_duration(self) -> None:
        assert STALLED_INTERVAL_MS == LOCK_DURATION_MS // 2

    def test_max_stalled_count(self) -> None:
        assert MAX_STALLED_COUNT == 3

    def test_idle_timeout_disabled_by_default(self) -> None:
        assert IDLE_TIMEOUT_SECONDS == 0


class TestProcessTrainingExport:
    @pytest.fixture
    def mock_job(self) -> MagicMock:
        job = MagicMock()
        job.data = {"since": "2026-01-01T00:00:00Z", "until": "2026-04-01T00:00:00Z"}
        job.updateProgress = AsyncMock()
        return job

    @pytest.mark.asyncio
    async def test_fails_with_retirement_message(self, mock_job: MagicMock) -> None:
        with (
            patch.dict("os.environ", {}, clear=True),
            pytest.raises(
                RuntimeError,
                match=re.escape(POSTGRES_METRIC_STREAM_EXPORT_RETIRED_MESSAGE),
            ),
        ):
            await process_training_export(mock_job, "token-123")

    @pytest.mark.asyncio
    async def test_missing_since_until_still_fails_with_retirement_message(self) -> None:
        job = MagicMock()
        job.data = {}
        job.updateProgress = AsyncMock()

        with pytest.raises(
            RuntimeError,
            match=re.escape(POSTGRES_METRIC_STREAM_EXPORT_RETIRED_MESSAGE),
        ):
            await process_training_export(job, "token-123")
