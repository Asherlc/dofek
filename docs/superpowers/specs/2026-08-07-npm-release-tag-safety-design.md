# npm Release Tag Safety

**Date:** 2026-08-07  
**Status:** Approved design

## Context

The `Version npm Packages` workflow failed when Lerna tried to create
`@dofek/eight-sleep@0.1.1`, because that tag already existed. The earlier
release workflow had attempted to push a version commit to protected `main`;
the branch update was rejected while a non-atomic fallback still pushed the
tags. The resulting tags were neither merged into `main` nor published to
npm. See the [failing job](https://github.com/Asherlc/dofek/actions/runs/31107678911/job/92636979937)
and the [preceding rejected release](https://github.com/Asherlc/dofek/actions/runs/30205750284).

The current version workflow passes `--no-push`, but Lerna's `version` command
still creates its local version commit and tags unless git tag versioning is
disabled. Lerna documents that `version` commits and tags version changes by
default ([Lerna version and publish](https://lerna.js.org/docs/features/version-and-publish)).

## Goals

- Make version-PR preparation independent of local or remote release tags.
- Keep release tags owned by the post-publish workflow.
- Allow existing stale tags to remain without requiring destructive cleanup.
- Preserve the reviewed pull-request path required by protected `main`.

## Non-goals

- Do not delete, move, or force-update existing remote tags.
- Do not change npm publishing, trusted publishing, or package version policy.
- Do not add a second release implementation or a registry-specific recovery
  path.

## Design

### Version pull request

Change `.github/workflows/version-npm.yml` to invoke:

```text
pnpm exec lerna version patch --yes --no-git-tag-version --no-push
```

`--no-git-tag-version` prevents Lerna from creating both the local commit and
local tags. The workflow then explicitly stages and commits the versioned
package manifests before creating the `release/npm-*` branch. The explicit
commit preserves the existing branch-and-pull-request flow while ensuring that
no tag operation occurs before the pull request is merged.

### Published release tags

`.github/workflows/release-npm.yml` remains the sole owner of release-tag
creation. It publishes the versions present on the merged `main` commit, then
creates only tags that are absent. If a stale tag already exists, publishing
can still recover the corresponding npm version and the tag step remains
idempotent.

### Documentation

Update `docs/package-publishing.md` to describe the explicit commit and the
`--no-git-tag-version --no-push` invocation. Update the existing incident
baseline entry with the prevention fix and its validation evidence.

## Failure behavior

- A stale remote tag cannot collide with version-PR preparation because the
  version workflow does not create tags.
- A protected-branch rule cannot leave version tags behind because the version
  workflow pushes only the release branch.
- A publish failure remains recoverable through the existing manual release
  workflow; tag creation remains after publish and skips already-existing tags.

## Validation

- Verify the workflow command and explicit commit are present in the diff.
- Run the repository's workflow/configuration validation available locally.
- Exercise the Lerna command in an isolated disposable checkout containing an
  existing package tag, confirming that it updates manifests without creating
  a local tag and that the explicit commit captures the changes.
- Run the relevant package and workflow checks without deleting or moving
  remote tags.

## Risks and rollback

The version step now owns a small amount of git plumbing (`git add` and
`git commit`). A clean checkout and the existing `has_changes` gate keep that
scope bounded. If validation reveals an unexpected Lerna workspace update,
the workflow change can be reverted without touching remote tags or npm
versions.
