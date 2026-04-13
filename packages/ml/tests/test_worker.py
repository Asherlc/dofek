"""Tests for dofek_ml.worker -- BullMQ training export worker."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

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
    def test_lock_duration_matches_node_worker(self) -> None:
        """Lock duration must match the Node.js worker's TRAINING_EXPORT_LOCK_MS (600_000)."""
        assert LOCK_DURATION_MS == 600_000

    def test_stalled_interval_is_half_lock_duration(self) -> None:
        assert STALLED_INTERVAL_MS == LOCK_DURATION_MS // 2

    def test_max_stalled_count(self) -> None:
        assert MAX_STALLED_COUNT == 3

    def test_idle_timeout_is_5_minutes(self) -> None:
        assert IDLE_TIMEOUT_SECONDS == 300


class TestProcessTrainingExport:
    @pytest.fixture()
    def mock_job(self) -> MagicMock:
        job = MagicMock()
        job.data = {"since": "2026-01-01T00:00:00Z", "until": "2026-04-01T00:00:00Z"}
        job.updateProgress = AsyncMock()
        return job

    @pytest.mark.asyncio()
    async def test_raises_without_database_url(self, mock_job: MagicMock) -> None:
        with patch.dict("os.environ", {}, clear=True):
            with pytest.raises(RuntimeError, match="DATABASE_URL"):
                await process_training_export(mock_job, "token-123")

    @pytest.mark.asyncio()
    async def test_calls_export_to_parquet(self, mock_job: MagicMock) -> None:
        fake_manifest: dict[str, Any] = {"totalRows": 42, "files": []}

        with (
            patch.dict(
                "os.environ",
                {"DATABASE_URL": "postgres://test:test@localhost/test"},
            ),
            patch("dofek_ml.worker.psycopg") as mock_psycopg,
            patch("dofek_ml.worker.export_to_parquet", return_value=fake_manifest) as mock_export,
        ):
            mock_conn = MagicMock()
            mock_psycopg.connect.return_value.__enter__ = MagicMock(return_value=mock_conn)
            mock_psycopg.connect.return_value.__exit__ = MagicMock(return_value=False)

            result = await process_training_export(mock_job, "token-123")

        assert result == fake_manifest
        mock_export.assert_called_once()
        call_kwargs = mock_export.call_args
        assert call_kwargs[1]["since"] == "2026-01-01T00:00:00Z"
        assert call_kwargs[1]["until"] == "2026-04-01T00:00:00Z"

    @pytest.mark.asyncio()
    async def test_passes_none_for_missing_since_until(self) -> None:
        job = MagicMock()
        job.data = {}
        job.updateProgress = AsyncMock()
        fake_manifest: dict[str, Any] = {"totalRows": 0, "files": []}

        with (
            patch.dict(
                "os.environ",
                {"DATABASE_URL": "postgres://test:test@localhost/test"},
            ),
            patch("dofek_ml.worker.psycopg") as mock_psycopg,
            patch("dofek_ml.worker.export_to_parquet", return_value=fake_manifest) as mock_export,
        ):
            mock_conn = MagicMock()
            mock_psycopg.connect.return_value.__enter__ = MagicMock(return_value=mock_conn)
            mock_psycopg.connect.return_value.__exit__ = MagicMock(return_value=False)

            await process_training_export(job, "token-123")

        call_kwargs = mock_export.call_args
        assert call_kwargs[1]["since"] is None
        assert call_kwargs[1]["until"] is None
