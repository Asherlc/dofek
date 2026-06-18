"""Tests for the retired Postgres metric-stream training export entrypoint."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING
from unittest.mock import patch

import pytest

from dofek_ml.export import (
    POSTGRES_METRIC_STREAM_EXPORT_RETIRED_MESSAGE,
    export_to_parquet,
    main,
)

if TYPE_CHECKING:
    from pathlib import Path


def test_export_to_parquet_fails_with_retirement_message(tmp_path: Path) -> None:
    with pytest.raises(
        RuntimeError,
        match=re.escape(POSTGRES_METRIC_STREAM_EXPORT_RETIRED_MESSAGE),
    ):
        export_to_parquet(object(), tmp_path)


def test_main_help_exits_cleanly() -> None:
    with (
        patch("sys.argv", ["export", "--help"]),
        pytest.raises(SystemExit) as exc_info,
    ):
        main()
    assert exc_info.value.code == 0


def test_main_fails_with_retirement_message(tmp_path: Path) -> None:
    with (
        patch("sys.argv", ["export", "--output-dir", str(tmp_path)]),
        pytest.raises(
            RuntimeError,
            match=re.escape(POSTGRES_METRIC_STREAM_EXPORT_RETIRED_MESSAGE),
        ),
    ):
        main()
