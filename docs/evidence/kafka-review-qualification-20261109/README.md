# Kafka parent review qualification — November 9 UTC

Kafka-only phase 1 is already live; its
[separate execution receipt](../../../deploy/kafka/phase1-execution.md) is not
qualification of a new shared application image. No production changes were
made during this review preparation.

The stock [read-only Terraform plan](https://github.com/Asherlc/dofek/actions/runs/42549866789)
used full source `8a9c8de03c910a36f2f7dac397317e992324bf6e` and reported
`No changes. Your infrastructure matches the configuration.` at 02:15:23 UTC.
No apply ran. Subsequent Terraform-file edits only clarify comments; managed
R2 resources and credential resources remain unchanged.

The first dispatch used the abbreviated revision `8a9c8de03`. Checkout treated
it as a branch/tag pattern, fetched no matching ref, and exited 1 before any
Terraform action. The corrected dispatch supplied the full forty-character SHA;
no retries, waits, provider permissions or credentials were changed to fix it.

Review validation:

- A real-filesystem regression first reproduced rejection of `.samples`.
  The narrow schema correction accepts Kafka's valid character set while still
  rejecting reserved `.` and `..`; the 59-test native-storage suite passed.
  See [Kafka 4.4 topic validation](https://github.com/apache/kafka/blob/4.4.0/clients/src/main/java/org/apache/kafka/common/internals/Topic.java).
- The runtime fixture now returns distinct native generations for source and
  quarantine topics and asserts both capture arguments and preserved checkpoint
  fields. The native-storage and runtime files passed 62 focused tests together.
- The final affected suite passed 129 tests across native storage, logical drain,
  runtime wiring, phase completion and deployment-environment rendering.
- Root, server and web TypeScript checks passed. Changed TypeScript files passed
  CSpell and Biome. Standalone Actionlint, including ShellCheck, passed the
  deployment workflow; no lint rule was suppressed. Terraform formatting passed.
- Controlled Bash execution made no production calls. It demonstrated that the
  old API-only gate accepts a paused broker, while the revised gate rejects
  paused/updating state or the wrong image and accepts a healthy completed
  rollout. A regex-lookalike quarantine name fails literal membership checking.
  An inspection failure exits even from a conditional function caller without
  executing a service update.
- The same existing external native API probe is reused before mutations and
  at actual stack-apply/consumer-restoration boundaries using GitHub's
  [stock YAML anchors](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations#yaml-anchors-and-aliases).
  Existing retry budgets and migration/CDC overlays are unchanged. Only the
  ClickHouse/analytics/reconciliation services are CDC-quiesced; the archive
  services and rolling web behavior are not represented as globally paused.

Cloudflare's official contracts establish that
[account-token permission-group listing accepts Write or Read](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/subresources/permission_groups/methods/get/),
and [Bucket Item Write includes object reading](https://developers.cloudflare.com/r2/api/tokens/#permission-groups).
Neither review finding justified expanding permissions or rotating credentials.

[Retained historical console summaries](retained-test-summaries.txt) support older
reported test counts only. They lack embedded source SHAs, include their initial
failures and must not be transferred to a new image or treated as current tests.
The unselected early formatter/disk experiment lacks raw retained output and is
explicitly distinguished from the later qualified tiered child.

The shared-image build, packaged checks, current-head CI settlement and exact
combined merge/release approval remain pending. The dedicated Terraform provider
token is consumed as a GitHub environment secret; the names-only production
Infisical export did not include `CLOUDFLARE_TERRAFORM_R2_API_TOKEN`. Existing source comments are not
evidence of user approval for a project-policy exception. No credential was
created, copied or edited during this review.
