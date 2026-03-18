---
name: fix-provider
description: Diagnose and fix a provider that isn't showing up in the UI (failing validation, missing env vars, broken config).
---

# Fix Provider

Diagnose why a provider isn't showing in the UI and fix the root cause. Providers that fail `validate()` are hidden from users, so "I can't see X" means X is broken.

## Current state

- Branch: !`git branch --show-current`
- Status: !`git status --short`

## Arguments

`$ARGUMENTS` should be the provider name or ID (e.g., "peloton", "garmin", "strava"). If not provided, ask the user which provider.

## Steps

### 1. Find the provider implementation

Look up the provider file under `src/providers/`. Each provider is self-contained in its own file.

```bash
ls src/providers/ | grep -i "$ARGUMENTS"
```

### 2. Check the validate() method

Read the provider's `validate()` method to understand what config/env vars it requires. This is the method that determines whether the provider shows up in the UI — if it returns a non-null string, the provider is hidden.

### 3. Check the server environment

SSH into the production server and check if the required env vars are set (check presence only — never print values):

```bash
ssh dofek 'docker exec dofek-web env | grep -i <PROVIDER_NAME> | cut -d= -f1'
```

**Warning**: Do not paste env var values into issues, PRs, or chat — they may contain secrets. Check presence only.

Compare the variable names against what `validate()` requires.

### 4. Check the provider registration

Verify the provider is registered in `packages/server/src/routers/sync.ts` in the `doRegisterProviders()` function. If it's not in the list, it won't appear regardless of config.

### 5. Diagnose and fix

Common causes:
- **Missing env vars**: Add them to the SOPS-encrypted `.env` file locally, commit, and deploy via Terraform
- **Wrong env var names**: The provider expects a different name than what's configured
- **OAuth app not created**: The provider needs an OAuth app registered with the third-party service
- **Registration error**: The provider constructor throws during `doRegisterProviders()` — check server logs for warnings

### 6. Verify the fix

After fixing, verify locally:
- The provider's `validate()` returns null with the correct env vars
- The provider appears in the `providers` API response
- Run the relevant unit tests

## Important

- Never disable validation or show broken providers as a workaround
- Environment secrets must be edited locally in the SOPS `.env` file, never on the server directly
- If the fix requires creating an OAuth app with a third-party service, document the steps and ask the user to complete them
