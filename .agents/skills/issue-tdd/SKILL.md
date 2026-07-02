---
name: issue-tdd
description: Use when the user asks for a TDD plan, test-first implementation outline, planning issue, or GitHub issue for a feature, bug, investigation, or vague implementation request.
---

# Issue TDD

Create a concrete test-driven development plan, save it in the appropriate docs folder, and open a GitHub issue that points to the plan.

## Arguments

`$ARGUMENTS` should describe the problem, feature, bug, investigation, or rough idea. If the request lacks enough information to define expected behavior, ask concise clarifying questions before writing the plan.

## Steps

### 1. Understand the request

- Read the relevant existing docs and code before planning. Use CodeGraph for structural code questions and `rg` for literal text searches.
- Identify the desired behavior, affected platforms/packages, user impact, non-goals, and any constraints from `AGENTS.md`.
- If multiple valid approaches or trade-offs exist, ask the user to choose before committing to a strategy.

### 2. Choose the docs location

Prefer the most specific existing docs folder:

- Use `docs/superpowers/plans/` for implementation/TDD plans.
- Use `docs/superpowers/specs/` only when the task first needs a design/spec document separate from the implementation plan.
- Use a domain-specific docs folder/file only when the plan belongs with an existing domain runbook or provider document.

Name new plan files as `YYYY-MM-DD-short-slug.md`. Use the current local date in the workspace timezone, formatted like `rtk date +%F`, plus lowercase words and hyphens.

### 3. Write the TDD plan

The plan must be executable by another agent without rediscovering the whole problem. Use this structure unless the repo already has a stronger nearby convention:

```markdown
# <Feature or Fix> TDD Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development before implementation. If executing this plan task-by-task, also use superpowers:executing-plans or superpowers:subagent-driven-development as appropriate. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** <one-sentence outcome>

**Behavior:** <observable behavior after the change>

**Scope:** <included work and explicit non-goals>

**Docs:** <links to related docs or source references>

---

## Current Evidence

- <existing behavior, failing command, user report, or code path>

## Test Strategy

- Unit: <what logic is covered>
- Integration: <what boundaries or real services are covered>
- UI/mobile/web parity: <platform expectations, if relevant>

## File Structure

- Create/modify: `<path>` - <why>

## Tasks

### Task 1: Add Failing Tests

**Files:**
- Create/modify: `<test path>`

- [ ] Write failing tests for <behavior>.
- [ ] Run `rtk <test command>`.
- [ ] Confirm the tests fail for the expected reason.

### Task 2: Implement Minimal Fix

**Files:**
- Create/modify: `<source path>`

- [ ] Implement the smallest production change that satisfies the failing tests.
- [ ] Run `rtk <test command>`.
- [ ] Confirm the tests pass.

### Task 3: Final Verification

- [ ] Run relevant lint, typecheck, and test commands.
- [ ] Update docs or stories required by the touched area.
- [ ] Commit and push if the user requested implementation work.
```

Plan quality rules:

- Tests come before implementation in every task that changes behavior.
- Include exact commands with the required `rtk` prefix.
- Keep changes scoped; do not add resilience knobs, compatibility layers, or broad refactors unless the user explicitly approved them.
- Include web and mobile parity checks when the change touches user-facing behavior.
- For production incidents or infra failures, require evidence before behavior changes: failing command/step, first fatal log line, and causal explanation.

### 4. Create the GitHub issue

Use `gh issue create` after the plan file exists. Put the plan path near the top of the issue body.

Use a temp file for the issue body to avoid shell quoting problems. Set `plan_path` to the actual plan file you created before opening the issue:

```bash
issue_body_file="$(mktemp)"
plan_path="docs/superpowers/plans/2026-07-02-short-slug.md"
cat > "$issue_body_file" <<EOF
## TDD Plan

Plan: ${plan_path}

## Goal

<one-sentence outcome>

## Acceptance Criteria

- [ ] Failing tests are written before implementation.
- [ ] The implementation satisfies the documented behavior.
- [ ] Relevant lint, typecheck, and tests pass.

## Notes

<important constraints, non-goals, or open questions>
EOF

gh issue create --title "<title>" --body-file "$issue_body_file"
rm -f "$issue_body_file"
```

If `gh issue create` fails because authentication or network access is unavailable, keep the plan file and report the exact failure plus the issue title/body that should be created.

### 5. Final response

Report:

- Plan file path.
- GitHub issue URL or the reason it could not be created.
- Any open decisions the implementer must resolve before starting.

Do not start implementation unless the user explicitly requested it.
