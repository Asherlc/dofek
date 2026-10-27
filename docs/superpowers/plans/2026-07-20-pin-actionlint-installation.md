# Pin Actionlint Installation TDD Plan

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

- Unit/static policy: add fixture-backed checks that reject executable downloads and checksum files from mutable Git refs, accept a hard-coded checksum reviewed in the workflow or a checksum downloaded from the same immutable release tag, and fail on a checksum mismatch.
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
- [ ] Pin the release artifact and its checksum source to the same immutable release tag (or hard-code the reviewed published checksum) before execution.
- [ ] Keep the existing Actionlint invocation and workflow scope unchanged.
- [ ] Run the focused policy tests.

### Task 3: Final Verification

- [ ] Run the pinned Actionlint binary against `.github/workflows/`.
- [ ] Run `rtk pnpm lint` and the CI-policy unit tests.
- [ ] Verify the Actionlint job needs no mutable executable download.
- [ ] Prove a deliberately mismatched checksum fails installation before the binary executes.
- [ ] Record a short retrospective covering root cause, direct fix, validation evidence, and a concrete `AGENTS.md`, workflow README, or skill improvement for future supply-chain checks.
