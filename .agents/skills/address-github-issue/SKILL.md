---
name: address-github-issue
description: Start work on a GitHub issue, attach the branch, move it to In Progress, implement the fix, open a PR, and link the PR and issue bidirectionally.
---

# Address GitHub Issue

## Arguments

`$ARGUMENTS` is an issue number or URL. If missing, ask the user.

Resolve the issue number (works for both forms):

```bash
ISSUE_NUMBER=$(gh issue view "$ARGUMENTS" --json number -q .number)
ISSUE_URL=$(gh issue view "$ISSUE_NUMBER" --json url -q .url)
ISSUE_ID=$(gh issue view "$ISSUE_NUMBER" --json id -q .id)
export ISSUE_URL
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

### 2. Start work

Immediately attach the work branch to the issue and move the issue to In Progress in
Asherlc's GitHub project 1.

Link a GitHub development branch for the issue using the current branch name. Do not
switch branches unless the user explicitly approved branch switching.

```bash
BRANCH_NAME=$(git branch --show-current)
if [ -z "$BRANCH_NAME" ]; then
  echo "No current branch is checked out; cannot attach a branch to issue #$ISSUE_NUMBER." >&2
  exit 1
fi
export BRANCH_NAME

BRANCH_OID=$(git rev-parse HEAD)
REPOSITORY_ID=$(gh repo view --json id -q .id)
LINKED_BRANCH_EXISTS=$(
  gh api graphql \
    -f issueId="$ISSUE_ID" \
    -f query='query($issueId: ID!) {
      node(id: $issueId) {
        ... on Issue {
          linkedBranches(first: 100) { nodes { ref { name } } }
        }
      }
    }' \
    -q 'first(.data.node.linkedBranches.nodes[]? | select(.ref.name == env.BRANCH_NAME) | .ref.name) // ""'
)

if [ -z "$LINKED_BRANCH_EXISTS" ]; then
  gh api graphql \
    -f issueId="$ISSUE_ID" \
    -f repositoryId="$REPOSITORY_ID" \
    -f name="$BRANCH_NAME" \
    -f oid="$BRANCH_OID" \
    -f query='mutation($issueId: ID!, $repositoryId: ID!, $name: String!, $oid: GitObjectID!) {
      createLinkedBranch(input: {issueId: $issueId, repositoryId: $repositoryId, name: $name, oid: $oid}) {
        linkedBranch { ref { name } }
      }
    }'
fi
gh issue develop --list "$ISSUE_NUMBER"
```

Move the issue to `In Progress` in <https://github.com/users/Asherlc/projects/1/views/1>.
If the issue is not already in the project, add it first.

The project commands require GitHub project scopes. If `gh` reports missing project
scopes, stop and ask the user to run `gh auth refresh -s read:project -s project`;
do not continue to implementation without the project move.

```bash
PROJECT_OWNER=Asherlc
PROJECT_NUMBER=1
REPOSITORY=$(gh repo view --json nameWithOwner -q .nameWithOwner)
PROJECT_ID=$(gh project view "$PROJECT_NUMBER" --owner "$PROJECT_OWNER" --format json -q .id)
PROJECT_ITEM_ID=$(
  gh project item-list "$PROJECT_NUMBER" \
    --owner "$PROJECT_OWNER" \
    --format json \
    --limit 100 \
    --query "repo:$REPOSITORY is:issue" \
    -q 'first(.items[] | select(.content.url == env.ISSUE_URL) | .id) // ""'
)

if [ -z "$PROJECT_ITEM_ID" ]; then
  PROJECT_ITEM_ID=$(gh project item-add "$PROJECT_NUMBER" --owner "$PROJECT_OWNER" --url "$ISSUE_URL" --format json -q .id)
fi

STATUS_FIELD_ID=$(gh project field-list "$PROJECT_NUMBER" --owner "$PROJECT_OWNER" --format json -q '.fields[] | select(.name == "Status") | .id')
IN_PROGRESS_OPTION_ID=$(gh project field-list "$PROJECT_NUMBER" --owner "$PROJECT_OWNER" --format json -q '.fields[] | select(.name == "Status") | .options[] | select(.name == "In Progress") | .id')

gh project item-edit \
  --id "$PROJECT_ITEM_ID" \
  --project-id "$PROJECT_ID" \
  --field-id "$STATUS_FIELD_ID" \
  --single-select-option-id "$IN_PROGRESS_OPTION_ID"
```

Do not continue to implementation until the branch is linked and the project item is
In Progress.

### 3. Address it

Implement the fix on the current branch. Use other skills as needed (`write-tests`, `ship-pr`, etc.).

### 4. Link PR ↔ issue

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
