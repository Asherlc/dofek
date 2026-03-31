# dofek-ml

ML activity classifier for wearable sensor data. Fused CNN that combines metric streams (1 Hz: heart rate, power, cadence) with per-device sensor streams (50 Hz: accelerometer, gyroscope) to classify activities.

## Setup

```bash
brew install uv    # or: curl -LsSf https://astral.sh/uv/install.sh | sh
cd packages/ml
uv sync            # creates .venv, installs all dependencies
```

## Usage

```bash
# Train from local export
uv run python -m dofek_ml.training --local-path /path/to/training-export/

# Train from R2 (env vars must be set)
uv run python -m dofek_ml.training

# Inspect training data
uv run python -m dofek_ml.data_loading --local-path /path/to/training-export/
```

## Development

```bash
uv run ruff check src/ tests/          # lint
uv run ruff format src/ tests/         # format
uv run ruff format --check src/ tests/ # format check
uv run mypy src/ tests/                # type check
uv run pytest                          # tests
uv run pytest --cov                    # tests with coverage
```

## Architecture

The model is a fused multi-branch CNN:

```
Metric stream (1 Hz)       -> [MetricBranch CNN]  -> 64 features ─┐
Apple Watch (50 Hz)        -> [DeviceBranch CNN]   -> 64 features ──┤-> Classifier -> activity type
WHOOP (50 Hz, 6-axis+HR)  -> [DeviceBranch CNN]   -> 64 features ─┘
```

Each device gets its own conv branch (separate weights) because sensor placement affects signal patterns. The classifier sees all branches concatenated and learns cross-device correlations.

## Project Structure

```
src/dofek_ml/
  __init__.py
  data_loading.py    # Load training data from local files or Cloudflare R2
  training.py        # Model definition, training loop, evaluation
tests/
  test_data_loading.py
  test_training.py
```
