---
name: address-github-issue
description: Read a GitHub issue, implement the fix, open a PR, and link the PR and issue bidirectionally.
---

# Address GitHub Issue

## Arguments

`$ARGUMENTS` is an issue number or URL. If missing, ask the user.

## Steps

### 1. Read the issue

```bash
ISSUE_NUMBER=<number>
gh issue view "$ISSUE_NUMBER" --comments
```

Check for an existing open linked PR before starting work:

```bash
gh issue develop "$ISSUE_NUMBER" --list
```

If one already addresses the issue, stop and tell the user.

### 2. Address it

Implement the fix on the current branch. Use other skills as needed (`write-tests`, `ship-pr`, etc.).

### 3. Link PR ↔ issue

After opening the PR (via `ship-pr` or `gh pr create`), ensure both directions are linked:

**PR → issue:** PR body must include `Fixes #<ISSUE_NUMBER>`.

**Issue → PR:** Comment on the issue with the PR link:

```bash
PR_NUMBER=$(gh pr view --json number -q .number)
PR_URL=$(gh pr view --json url -q .url)

gh issue comment "$ISSUE_NUMBER" --body "Opened PR #${PR_NUMBER} to address this: ${PR_URL}"
```

Do not finish without both links in place.
