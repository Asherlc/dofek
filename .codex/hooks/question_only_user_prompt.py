#!/usr/bin/env python3
import json
import re
import sys
from pathlib import Path

STATE_ROOT = Path("/tmp/codex-question-only-policy")

ACTION_WORD_PATTERN = re.compile(
    r"\b("
    r"edit|change|modify|update|implement|fix|create|add|remove|delete|"
    r"refactor|run|execute|rename|commit|push|write|build|deploy|install|"
    r"make|setup|configure|set\s+up"
    r")\b"
)
QUESTION_START_PATTERN = re.compile(
    r"^(is|are|am|can|could|would|should|do|does|did|will|what|why|how|when|where|who|which)\b"
)


def safe_token(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", value)


def state_path(session_id: str, turn_id: str) -> Path:
    return STATE_ROOT / safe_token(session_id) / f"{safe_token(turn_id)}.json"


def is_question_only(prompt: str) -> bool:
    normalized_prompt = prompt.strip().lower()
    if not normalized_prompt:
        return False
    if ACTION_WORD_PATTERN.search(normalized_prompt):
        return False
    if normalized_prompt.endswith("?"):
        return True
    return bool(QUESTION_START_PATTERN.match(normalized_prompt))


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        return 0

    session_id = str(payload.get("session_id") or "")
    turn_id = str(payload.get("turn_id") or "")
    if not session_id or not turn_id:
        return 0

    prompt = str(payload.get("prompt") or "")
    question_only = is_question_only(prompt)

    path = state_path(session_id, turn_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"question_only": question_only}))

    if question_only:
        output = {
            "hookSpecificOutput": {
                "hookEventName": "UserPromptSubmit",
                "additionalContext": (
                    "This prompt is question-only. Answer directly. Do not run tools "
                    "or make changes unless the user explicitly asks for it."
                ),
            }
        }
        print(json.dumps(output))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
