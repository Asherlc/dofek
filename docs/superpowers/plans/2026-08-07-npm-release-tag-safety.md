# npm Release Tag Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the npm version workflow from creating local release tags before a reviewed pull request is merged, so stale or rejected-release tags cannot block future version PRs.

**Architecture:** Lerna will update package manifests without committing or tagging by using `--no-git-tag-version --no-push`. The workflow will explicitly commit those manifest changes and push only the release branch; the existing post-publish workflow remains the sole tag writer. Documentation will record the invariant and recovery behavior.

**Tech Stack:** GitHub Actions YAML, Lerna 9.0.7, pnpm, Git, Markdown documentation.

## Global Constraints

- Do not delete, move, or force-update existing remote tags.
- Keep `.github/workflows/release-npm.yml` as the only workflow that creates release tags.
- Preserve the reviewed pull-request path required by protected `main`.
- Do not add a dedicated test for static workflow configuration; validate through workflow checks and an executable isolated git/Lerna reproduction.
- Use the repository's `rtk` command prefix for shell commands.
- Update active documentation and incident evidence with citations to official Lerna guidance.

---

### Task 1: Make version-PR preparation tag-free

**Files:**
- Modify: `.github/workflows/version-npm.yml:104-111`

**Interfaces:**
- Consumes: the existing `steps.changed.outputs.has_changes` gate and Lerna package version updates.
- Produces: a committed `release/npm-<short-main-sha>` branch with version manifest changes and no local release tags.

- [ ] **Step 1: Update the Lerna invocation and explicit commit**

Replace the current version command and branch creation sequence with:

```yaml
          # Lerna's --no-push still creates its local version commit and tags.
          # Disable both so release tags are created only after publishing.
          pnpm exec lerna version patch --yes --no-git-tag-version --no-push
          git add --all
          git commit -m "chore(release): version npm packages"
          git branch "$BRANCH"
```

Keep the existing `git push`, pull request creation, and auto-merge commands unchanged. The checkout is clean and the `has_changes` gate ensures the explicit commit has version changes to capture.

- [ ] **Step 2: Review the workflow diff for scope**

Run:

```bash
rtk git diff -- .github/workflows/version-npm.yml
rtk git diff --check
```

Expected: only the Lerna flags, explanatory comment, `git add --all`, and explicit `git commit` are added or changed; no tag deletion, force push, or release-workflow change appears.

### Task 2: Align release documentation and incident record

**Files:**
- Modify: `docs/package-publishing.md:21-43`
- Modify: `docs/production-incident-baseline.md:294-319`

**Interfaces:**
- Consumes: the workflow invariant from Task 1 and the existing npm release recovery procedure.
- Produces: human-readable documentation that explains why version PR preparation cannot create tags and how post-publish tag recovery works.

- [ ] **Step 1: Update the npm architecture sequence**

Change the version-workflow step to name both flags and the explicit commit. State that Lerna updates manifests only, then the workflow commits and pushes the release branch. Retain the official [Lerna version and publish](https://lerna.js.org/docs/features/version-and-publish) citation.

- [ ] **Step 2: Update the incident baseline**

Add the prevention fix to the existing npm incident entry: `--no-git-tag-version --no-push` prevents local tag creation, and the explicit commit preserves the pull-request flow. State that stale tags are intentionally preserved and the post-publish workflow remains idempotent.

- [ ] **Step 3: Check documentation formatting and claims**

Run:

```bash
rtk git diff --check
rtk rg -n "no-git-tag-version|no-push|release tags|Lerna version and publish" docs/package-publishing.md docs/production-incident-baseline.md
```

Expected: both active docs describe the same workflow behavior and retain links to the official Lerna documentation and incident evidence.

### Task 3: Execute focused verification and commit

**Files:**
- Verify: `.github/workflows/version-npm.yml`
- Verify: `docs/package-publishing.md`
- Verify: `docs/production-incident-baseline.md`

**Interfaces:**
- Consumes: the tag-free version workflow and documentation from Tasks 1–2.
- Produces: fresh evidence that Lerna updates manifests without creating a local tag and that the repository checks pass.

- [ ] **Step 1: Validate workflow syntax with available repository tooling**

Run the repository's focused workflow/configuration validation available in the workspace. If no dedicated workflow validator exists, use YAML parsing or the repository lint command that covers workflow files; do not add a static-config unit test.

- [ ] **Step 2: Run an isolated executable Lerna reproduction**

Use a disposable copy or worktree outside the repository's active worktree with a clean git repository, one public package at version `0.1.0`, and an existing `@example/package@0.1.1` tag. Run:

```bash
pnpm exec lerna version patch --yes --no-git-tag-version --no-push
git add --all
git commit -m "chore(release): version npm packages"
```

Verify that the package manifest is `0.1.1`, the explicit commit exists, and `git tag --list '@example/package@0.1.1'` is empty in the reproduction. Remove the disposable copy after verification; do not touch repository or remote tags.

- [ ] **Step 3: Run relevant repository checks**

Run:

```bash
rtk git diff --check
rtk pnpm lint
rtk git status --short
```

Expected: no whitespace errors, lint exits successfully, and only the intended workflow/documentation changes remain uncommitted before the final commit.

- [ ] **Step 4: Commit the implementation**

Run:

```bash
rtk git add .github/workflows/version-npm.yml docs/package-publishing.md docs/production-incident-baseline.md
rtk git commit -m "fix(ci): keep npm versioning tag-free"
```

Report the commit, validation output, and the remaining operational requirement: the next successful `CI` run should create the version PR, after which the release workflow should publish and verify the package versions.
