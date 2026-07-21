# Pin Actionlint Installation TDD Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development before implementation. If executing this plan task-by-task, also use superpowers:executing-plans or superpowers:subagent-driven-development as appropriate. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Actionlint CI job execute an immutable, reviewed tool artifact.

**Behavior:** CI installs a specific current stable Actionlint release with integrity verification and does not fetch executable installer code from a mutable branch.

**Scope:** Replace the Actionlint installation step and add a policy regression check. Do not change workflow lint rules in this issue.

**Docs:** [GitHub secure-use reference](https://docs.github.com/en/actions/how-tos/security-for-github-actions/security-guides/security-hardening-for-github-actions#using-third-party-actions)

---

## Current Evidence

- `.github/workflows/test.yml` executes `bash <(curl -s https://raw.githubusercontent.com/rhysd/actionlint/main/scripts/download-actionlint.bash)`.
- `main` is mutable and the downloaded script is neither version-pinned nor integrity-checked.
- This is distinct from the repository's broken `uses:` pinning gate because the executable is fetched from inside a shell step.

## Test Strategy

- Unit/static policy: add a fixture-backed check that rejects executable downloads from mutable Git refs and accepts a version-plus-checksum installation.
- Integration: run Actionlint from the pinned installation path against all workflows.
- UI/mobile/web parity: not applicable.

## File Structure

- Modify: `.github/workflows/test.yml` - install a current stable immutable Actionlint release.
- Create/modify: repository CI policy script and colocated tests - prevent mutable executable installer URLs.

## Tasks

### Task 1: Add Failing Tests

- [ ] Add a failing policy fixture for the current `raw.githubusercontent.com/.../main/...` installer execution.
- [ ] Run `rtk pnpm vitest run --project unit <test-path>`.
- [ ] Confirm the test fails on the current workflow.

### Task 2: Implement the Minimal Fix

- [ ] Determine the current stable Actionlint release from the upstream release source.
- [ ] Pin the release and verify its published checksum before execution.
- [ ] Keep the existing Actionlint invocation and workflow scope unchanged.
- [ ] Run the focused policy tests.

### Task 3: Final Verification

- [ ] Run the pinned Actionlint binary against `.github/workflows/`.
- [ ] Run `rtk pnpm lint` and the CI-policy unit tests.
- [ ] Verify the Actionlint job needs no mutable executable download.
