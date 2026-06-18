# Staging Environment

Staging is disabled. The old Hetzner staging server, block storage volume, DNS
records, and deploy workflow output are no longer managed by the main
`deploy/` Terraform root.

## Historical Shape

- App: `staging.dofek.asherlc.com`
- OTA: `staging-ota.dofek.asherlc.com`
- Management:
  - `staging-portainer.dofek.asherlc.com`
  - `staging-netdata.dofek.asherlc.com`
  - `staging-databasus.dofek.asherlc.com`
  - `staging-pgadmin.dofek.asherlc.com`
- Docker stack: `dofek-staging`
- Infisical environment: `staging`

These hosts are historical references only while staging remains disabled.

## Deploy

Staging deployments are disabled in **Deploy Web**. Successful main CI and
manual deploys update production only.

When re-enabled, the workflow:

1. Confirms the `dofek` GHCR image tag exists.
2. Provisions staging infrastructure in a dedicated Terraform root or explicitly
   reintroduces staging resources to `deploy/`.
3. Exports Infisical secrets from the `staging` environment.
4. Deploys `deploy/stack.yml` as the `dofek-staging` Docker stack.
5. Runs migrations against the staging database before updating services.

## Secrets

The `staging` Infisical environment must contain the same required runtime keys as `prod`, but with staging-safe values.

Do not point staging at the production database or any production webhook endpoint.
