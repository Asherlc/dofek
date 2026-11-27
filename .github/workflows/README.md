# GitHub Actions

Workflow names group the Actions sidebar by purpose. Filenames remain stable so
CLI commands and links keep working. GitHub uses the top-level
[`name`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#name)
as the workflow label; `Reusable / …` identifies helpers called by other workflows.
These are labels, not folders or hidden workflows.

## Entry points

- **CI** (`ci.yml`): validation, build artifacts, and the existing required check
  names for pull requests and main pushes. It does not deploy production.
- **Release / Production** (`deploy-web.yml`): automatic server, OTA, and
  TestFlight publication after a completed main-push CI run, plus the single
  manual production release entry point. Dispatch from `main`; select `web`
  (the default), `web-stack`, `ios`, `ota`, `infra`, or coordinated `all`.
  An optional `image_tag` selects the immutable image's source before manual
  validation. See the [deployment runbook](../../deploy/README.md#flow-diagram).
- **Release / …**: npm package publication, npm version PRs, Swift packages,
  and the Zepp store release. These retain their existing triggers and gates.
- **Build / …**: manually runnable server, ML, OTA-server and Pulsar image builds.
- **Operations / Terraform**: explicit Terraform plan/apply; manual runs default
  to a read-only plan. Production infrastructure-only releases use the `infra`
  target in Release / Production.
- **Preview / …**, **Security / …**, **Maintenance / …**, and **Automation / …**:
  preview, analysis, housekeeping and agent workflows.
- **Reusable / …**: check, build, reporting and deployment helpers. Their
  individual job names remain stable; start with CI or Release / Production.

## Exact source and artifact handoff

The iOS CI archive, signed release archive, and TestFlight export use
Xcode 27.2 on GitHub's `xcode-27` runner. Update their pins together when
upgrading the release toolchain. See the [runner software inventory](https://github.com/actions/runner-images/blob/main/images/macos/xcode-27-arm64-Readme.md#xcode)
and [App Store submission requirements](https://developer.apple.com/app-store/submitting/).

The signed iOS archive restores the CocoaPods dependency cache published by
unsigned CI. Both workflows use the same key and cache directory. The signed
job runs `pod install` on every build.
[GitHub Actions cache matching](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#cache-key-matching).

CI uploads its native dependency results and outputs as
`release-inputs-<run_attempt>` for main pushes. Release / Production is triggered
by [`workflow_run`](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)
completion, downloads that exact run/attempt artifact, and checks the source
against the upstream `head_sha`. It accepts only this repository's completed
main-push CI runs. It does not check out or execute artifact contents.

The native completion trigger waits for all CI jobs, including queued builds.
Server, OTA and TestFlight publishers retain their own validation gates, so an
unrelated failed lane does not block a target whose prerequisites passed. Server
uses its immutable image digest; TestFlight downloads the signed archive by ID
from its originating CI run. Missing or expired inputs fail before publication.
Artifacts are retained for seven days; after expiry use a manual release to
validate/build again. GitHub documents
[cross-workflow artifact downloads](https://github.com/actions/download-artifact#download-artifacts-from-other-workflow-runs-or-repositories).

Manual requests retain the checks and source/image resolution in reusable
`deploy.yml`. They do not use an automatic CI handoff or bypass target gates.
GitHub's [manual workflow guide](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
explains the **Run workflow** button and CLI invocation.

Historical and GitHub-managed workflow entries are left intact; this change
does not delete run history or change repository settings.
