---
name: address-github-issue
description: Read a GitHub issue, implement the fix, open a PR, and link the PR and issue bidirectionally.
---

# Address GitHub Issue

## Arguments

`$ARGUMENTS` is an issue number or URL. If missing, ask the user.

Resolve the issue number (works for both forms):

```bash
ISSUE_NUMBER=$(gh issue view "$ARGUMENTS" --json number -q .number)
```

## Steps

### 1. Read the issue

```bash
gh issue view "$ISSUE_NUMBER" --comments
```

Check for an existing open PR before starting work:

```bash
gh pr list --search "Fixes #${ISSUE_NUMBER} OR Closes #${ISSUE_NUMBER}" --state open --json number,title,url
```

If one already addresses the issue, stop and tell the user.

### 2. Address it

Implement the fix on the current branch. Use other skills as needed (`write-tests`, `ship-pr`, etc.).

### 3. Link PR ↔ issue

After opening the PR, ensure both directions are linked.

**PR → issue:** PR body must include `Fixes #<ISSUE_NUMBER>`. If the PR was opened via `ship-pr` (or otherwise lacks it), append it:

```bash
PR_NUMBER=$(gh pr view --json number -q .number)
pr_body_file="$(mktemp)"
printf '%s\n\nFixes #%s\n' "$(gh pr view --json body -q .body)" "$ISSUE_NUMBER" > "$pr_body_file"
gh pr edit "$PR_NUMBER" --body-file "$pr_body_file"
rm -f "$pr_body_file"
```

**Issue → PR:** Comment on the issue with the PR link:

```bash
PR_URL=$(gh pr view --json url -q .url)

gh issue comment "$ISSUE_NUMBER" --body "Opened PR #${PR_NUMBER} to address this: ${PR_URL}"
```

Do not finish without both links in place.
