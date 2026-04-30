# Staging Environment

Staging is a production-shaped deployment used to test full deploy, migration, and runtime behavior without writing test state into the production database.

## Shape

- App: `https://staging.dofek.asherlc.com`
- OTA: `https://staging-ota.dofek.asherlc.com`
- Management:
  - `https://staging-portainer.dofek.asherlc.com`
  - `https://staging-netdata.dofek.asherlc.com`
  - `https://staging-databasus.dofek.asherlc.com`
  - `https://staging-pgadmin.dofek.asherlc.com`
- Docker stack: `dofek-staging`
- Infisical environment: `staging`

Terraform provisions a separate Hetzner server and block storage volume for staging. The staging stack uses the same `deploy/stack.yml` as production with environment-specific host rules and public URLs passed by `.github/workflows/deploy-web.yml`.
Staging DNS records point directly at the staging server so Traefik can serve the origin Let's Encrypt certificate.

## Deploy

Staging deploys automatically after successful main CI through **Deploy Web**, using the same `sha-<commit>` image tag as production. You can also run **Deploy Web** manually; `environment=both` is the default, and `environment=staging` deploys only staging.

The workflow:

1. Confirms the `dofek` and `dofek-ml` GHCR image tags exist.
2. Applies Terraform and reads `staging_server_ip`.
3. Exports Infisical secrets from the `staging` environment.
4. Deploys `deploy/stack.yml` as the `dofek-staging` Docker stack.
5. Runs migrations against the staging database before updating services.

## Secrets

The `staging` Infisical environment must contain the same required runtime keys as `prod`, but with staging-safe values.

Do not point staging at the production database or any production webhook endpoint.
