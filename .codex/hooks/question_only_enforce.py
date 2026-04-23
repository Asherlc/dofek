#!/usr/bin/env python3
import json
import re
import sys
from pathlib import Path

STATE_ROOT = Path("/tmp/codex-question-only-policy")


def safe_token(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", value)


def state_path(session_id: str, turn_id: str) -> Path:
    return STATE_ROOT / safe_token(session_id) / f"{safe_token(turn_id)}.json"


def is_question_only_turn(session_id: str, turn_id: str) -> bool:
    path = state_path(session_id, turn_id)
    if not path.exists():
        return False
    try:
        payload = json.loads(path.read_text())
    except json.JSONDecodeError:
        return False
    return bool(payload.get("question_only"))


def pre_tool_use_deny_payload() -> dict:
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": (
                "Question-only prompt policy: answer directly without running tools. "
                "Ask for explicit change instructions first."
            ),
        }
    }


def permission_request_deny_payload() -> dict:
    return {
        "hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "decision": {
                "behavior": "deny",
                "message": (
                    "Question-only prompt policy: answer directly without running tools."
                ),
            },
        }
    }


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        return 0

    session_id = str(payload.get("session_id") or "")
    turn_id = str(payload.get("turn_id") or "")
    if not session_id or not turn_id:
        return 0

    if not is_question_only_turn(session_id, turn_id):
        return 0

    hook_event_name = str(payload.get("hook_event_name") or "")
    if hook_event_name == "PreToolUse":
        print(json.dumps(pre_tool_use_deny_payload()))
    elif hook_event_name == "PermissionRequest":
        print(json.dumps(permission_request_deny_payload()))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
