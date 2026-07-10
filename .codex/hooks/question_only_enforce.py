#!/usr/bin/env python3
import json
import re
import shlex
import sys
from pathlib import Path

STATE_ROOT = Path("/tmp/codex-question-only-policy")

READ_ONLY_COMMANDS = {
    "cat",
    "command",
    "file",
    "find",
    "grep",
    "head",
    "ls",
    "nl",
    "pwd",
    "realpath",
    "rg",
    "sed",
    "stat",
    "tail",
    "true",
    "wc",
    "which",
}
READ_ONLY_GIT_SUBCOMMANDS = {
    "blame",
    "branch",
    "diff",
    "grep",
    "log",
    "ls-files",
    "rev-parse",
    "show",
    "status",
}
READ_ONLY_COMMAND_UTILITY_OPTIONS = {"--help", "-V", "-v"}
FIND_MUTATING_OPTIONS = {
    "-delete",
    "-exec",
    "-execdir",
    "-fls",
    "-fprint",
    "-fprint0",
    "-fprintf",
    "-ok",
    "-okdir",
}
RG_MUTATING_OPTIONS = {"--pre"}
MUTATING_SHELL_PATTERN = re.compile(
    r"(^|[;&|]\s*)("
    r"apply_patch|build|chmod|chown|commit|cp|curl|deploy|docker|gh|install|"
    r"ln|make|mkdir|mv|npm|pnpm|python|python3|rm|rsync|tee|touch|write"
    r")\b|>|<\(|\$\(|`|\bfind\b[^;&|]*\s-delete\b|\bsed\b[^;&|]*\s-i\b"
)


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


def shell_segments(command: str) -> list[str]:
    return [
        segment.strip()
        for segment in re.split(r"\s*(?:&&|\|\||;|\|)\s*", command)
        if segment.strip()
    ]


def command_tokens(command: str) -> list[str]:
    try:
        return shlex.split(command)
    except ValueError:
        return command.split()


def unwrap_rtk(tokens: list[str]) -> list[str]:
    if tokens and tokens[0] == "rtk":
        tokens = tokens[1:]
    if tokens[:1] == ["proxy"]:
        tokens = tokens[1:]
    return tokens


def is_read_only_command_utility(tokens: list[str]) -> bool:
    if len(tokens) == 2 and tokens[1] in READ_ONLY_COMMAND_UTILITY_OPTIONS:
        return True
    if len(tokens) > 2 and tokens[1] in READ_ONLY_COMMAND_UTILITY_OPTIONS:
        return True
    if len(tokens) > 3 and tokens[1] == "-p" and tokens[2] in {"-V", "-v"}:
        return True
    return False


def has_option(tokens: list[str], option_names: set[str]) -> bool:
    return any(
        token in option_names or any(token.startswith(f"{option}=") for option in option_names)
        for token in tokens
    )


def is_read_only_find(tokens: list[str]) -> bool:
    return not has_option(tokens[1:], FIND_MUTATING_OPTIONS)


def is_read_only_rg(tokens: list[str]) -> bool:
    return not has_option(tokens[1:], RG_MUTATING_OPTIONS)


def is_read_only_sed(tokens: list[str]) -> bool:
    for token in tokens[1:]:
        if token in {"-i", "--in-place"} or token.startswith(("-i", "--in-place=")):
            return False
        if token == "w" or re.search(r"(^|[;{}\n])\s*w($|\s+\S)", token):
            return False
        if re.search(r"^s(.).*?\1.*?\1[gp0-9]*w", token):
            return False
    return True


def is_read_only_segment(segment: str) -> bool:
    tokens = unwrap_rtk(command_tokens(segment))
    if not tokens:
        return True

    command = Path(tokens[0]).name
    if command == "git":
        return len(tokens) > 1 and tokens[1] in READ_ONLY_GIT_SUBCOMMANDS
    if command == "command":
        return is_read_only_command_utility(tokens)
    if command == "find":
        return is_read_only_find(tokens)
    if command == "rg":
        return is_read_only_rg(tokens)
    if command == "sed":
        return is_read_only_sed(tokens)
    return command in READ_ONLY_COMMANDS


def command_from_payload(payload: dict) -> str:
    tool_input = payload.get("tool_input")
    if isinstance(tool_input, dict):
        command = tool_input.get("command") or tool_input.get("cmd")
        if isinstance(command, str):
            return command

    command = payload.get("command") or payload.get("cmd")
    return command if isinstance(command, str) else ""


def is_read_only_command(command: str) -> bool:
    if not command.strip():
        return False
    if MUTATING_SHELL_PATTERN.search(command):
        return False
    return all(is_read_only_segment(segment) for segment in shell_segments(command))


def pre_tool_use_deny_payload() -> dict:
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": (
                "Question-only prompt policy: answer directly without making changes. "
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
                    "Question-only prompt policy: answer directly without making changes."
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
        if is_read_only_command(command_from_payload(payload)):
            return 0
        print(json.dumps(pre_tool_use_deny_payload()))
    elif hook_event_name == "PermissionRequest":
        print(json.dumps(permission_request_deny_payload()))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
