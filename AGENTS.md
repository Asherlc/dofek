# Agent Instructions

## Startup
- Read `CLAUDE.md` before starting work in this repository.

## Available Skills
- `fix-provider`: Diagnose and fix a provider that is missing from the UI because validation fails. (file: `.codex/skills/fix-provider/SKILL.md`)
- `check-logs`: Check production and local logs for failures and regressions. (file: `.codex/skills/check-logs/SKILL.md`)
- `ship-pr`: Finalize and ship a pull request with required checks. (file: `.codex/skills/ship-pr/SKILL.md`)
- `address-pr-comments`: Apply reviewer feedback on an open pull request. (file: `.codex/skills/address-pr-comments/SKILL.md`)

## Trigger Rules
- If the user names one of the skills above (plain text or `$skill-name`), read that skill's `SKILL.md` and follow it for the task.
- If the task clearly matches one of the skill descriptions above, use that skill even if not explicitly named.
