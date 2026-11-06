# Pulsar BookKeeper sealed-ledger offload target on Backblaze B2 (stock aws-s3).
# R2 metric-stream archive + account-erasure ledger resources in storage.tf stay unchanged.
#
# Lifecycle (1d hide→delete, 1d unfinished MPU cancel) is intended production config aligned
# with the active tiny B2 lifecycle experiment; that experiment remains UNQUALIFIED.
# Omit days_from_uploading_to_hiding so active ledgers are not age-hidden.
# Object Lock / file lock omitted (provider default disabled).
#
# Broker runtime key: readBuckets is required for S3 GetBucketLocation
# (https://www.backblaze.com/docs/cloud-storage-s3-compatible-app-keys).
# listAllBucketNames is intentionally omitted until Pulsar stock aws-s3 shows a ListBuckets
# call against a bucket-scoped key; least-privilege key qualification remains UNQUALIFIED.
#
# One-time Root credential grant (B2 IaC parent → GH secrets; Infisical CI write for
# PULSAR_OFFLOAD_B2_*): official HTTP + gh stdin only — docs/b2-pulsar-offload-iac.md
# Custom roles blocked (plan.rbac). Stock identity additional-privilege packet reviewed
# there (legacy flag confirmed true); POST held pending user pivot approval.

locals {
  # Same Infisical project as .infisical.json workspaceId (non-secret project id).
  infisical_project_id          = "54712f56-98a9-4531-9e97-0b588d2e5a88"
  pulsar_offload_b2_bucket_name = "dofek-pulsar-offload"
  pulsar_offload_b2_region      = "us-west-004"
  pulsar_offload_b2_endpoint    = "https://s3.us-west-004.backblazeb2.com"
}

resource "b2_bucket" "pulsar_offload" {
  bucket_name = local.pulsar_offload_b2_bucket_name
  bucket_type = "allPrivate"

  lifecycle_rules {
    file_name_prefix                                       = ""
    days_from_hiding_to_deleting                           = 1
    days_from_starting_to_canceling_unfinished_large_files = 1
  }

  # Stock Terraform meta-argument (not a custom destroy policy). Existing R2 buckets in
  # storage.tf do not set this today; Pulsar sealed-ledger storage warrants fail-closed
  # destroy protection because accidental TF destroy is irreversible for offloaded ledgers.
  lifecycle {
    prevent_destroy = true
  }
}

resource "b2_application_key" "pulsar_offload_broker" {
  key_name   = "dofek-pulsar-offload-broker"
  bucket_ids = [b2_bucket.pulsar_offload.bucket_id]

  capabilities = [
    "listFiles",
    "readFiles",
    "writeFiles",
    "deleteFiles",
    "readBuckets",
  ]
}

# Automatic runtime delivery into the same Infisical folder the deploy dotenv export reads
# (.github/templates/infisical-dotenv.tmpl → secret path `/`). Sensitive `value` (not
# value_wo): b2_application_key.application_key is already retained in encrypted HCP
# Terraform state; write-only Infisical fields only avoid a second Infisical provider state
# copy and add value_wo_version rotation machinery.
resource "infisical_secret" "pulsar_offload_b2_bucket" {
  name         = "PULSAR_OFFLOAD_B2_BUCKET"
  value        = b2_bucket.pulsar_offload.bucket_name
  env_slug     = "prod"
  workspace_id = local.infisical_project_id
  folder_path  = "/"
}

resource "infisical_secret" "pulsar_offload_b2_endpoint" {
  name         = "PULSAR_OFFLOAD_B2_ENDPOINT"
  value        = local.pulsar_offload_b2_endpoint
  env_slug     = "prod"
  workspace_id = local.infisical_project_id
  folder_path  = "/"
}

resource "infisical_secret" "pulsar_offload_b2_region" {
  name         = "PULSAR_OFFLOAD_B2_REGION"
  value        = local.pulsar_offload_b2_region
  env_slug     = "prod"
  workspace_id = local.infisical_project_id
  folder_path  = "/"
}

resource "infisical_secret" "pulsar_offload_b2_key_id" {
  name         = "PULSAR_OFFLOAD_B2_KEY_ID"
  value        = b2_application_key.pulsar_offload_broker.application_key_id
  env_slug     = "prod"
  workspace_id = local.infisical_project_id
  folder_path  = "/"
}

resource "infisical_secret" "pulsar_offload_b2_app_key" {
  name         = "PULSAR_OFFLOAD_B2_APP_KEY"
  value        = b2_application_key.pulsar_offload_broker.application_key
  env_slug     = "prod"
  workspace_id = local.infisical_project_id
  folder_path  = "/"
}
