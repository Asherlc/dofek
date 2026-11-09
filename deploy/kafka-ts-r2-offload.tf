# Existing managed R2 resources retained pending separate decommission approval.
# The canonical hot-log broker does not use these resources or credentials.
# Do not remove this declaration or schedule destruction as part of broker cutover.
# https://developer.hashicorp.com/terraform/language/meta-arguments/lifecycle#prevent_destroy
# Dedicated Cloudflare R2 bucket + long-lived Object RW key for Kafka tiered storage.
# Distinct from metric-stream archive and account-erasure ledger in storage.tf.
#
# Always declared (steady-state). Cloudflare resources use provider = cloudflare.r2
# (GH CLOUDFLARE_TERRAFORM_R2_API_TOKEN: Account API Tokens Write + Workers R2
# Storage Write). Default cloudflare provider / storage.tf / Infisical unchanged.
# Infisical CI additional privilege gha-kafka-ts-r2-secrets is already granted.
# See deploy/kafka/README.md.
#
# Stock paths only — no custom JWT signer, no temp-credential renewal service,
# no runtime parent fallback.
# Account token: https://registry.terraform.io/providers/cloudflare/cloudflare/5.19.0/docs/resources/account_token
# Create Token API accepted permission: Account API Tokens Write
#   https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/create/
# R2 S3 mapping: Access Key ID = token id; Secret = SHA-256(token value)
#   https://developers.cloudflare.com/r2/api/tokens/
# Bucket lifecycle MPU abort only (no live object age expiry) — GC is Kafka/RSM-owned.

locals {
  infisical_project_id    = "54712f56-98a9-4531-9e97-0b588d2e5a88"
  kafka_ts_r2_bucket_name = "dofek-kafka-ts-offload"
  kafka_ts_r2_region      = "auto"
  kafka_ts_r2_endpoint    = "https://${var.cloudflare_account_id}.r2.cloudflarestorage.com"
  # Account-owned token resource string (bucket scope) — not user/zone resources.
  # https://developers.cloudflare.com/r2/api/tokens/
  kafka_ts_r2_bucket_resource = "com.cloudflare.edge.r2.bucket.${var.cloudflare_account_id}_default_${local.kafka_ts_r2_bucket_name}"
}

# Permission-group listing accepts Account API Tokens Write OR Read. The managing
# token already needs Write to create the account token below.
# https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/subresources/permission_groups/methods/get/
# name/scope: plain strings. Provider 5.19 passes them through to cloudflare-go
# TokenPermissionGroupListParams.URLQuery() → url.Values.Encode() (QueryEscape).
# Pre-encoding ("%20") double-encodes to %2520. Schema text saying "URL-encoded"
# is OpenAPI-generated; runtime encoding is the client Encode path above.
# Primary sources:
#   https://github.com/cloudflare/terraform-provider-cloudflare/blob/v5.19.0/internal/services/account_api_token_permission_groups/list_data_source_model.go
#   https://github.com/cloudflare/cloudflare-go/blob/main/accounts/tokenpermissiongroup.go
data "cloudflare_account_api_token_permission_groups_list" "r2_bucket_item_write" {
  provider   = cloudflare.r2
  account_id = var.cloudflare_account_id
  name       = "Workers R2 Storage Bucket Item Write"
  scope      = "com.cloudflare.edge.r2.bucket"
}

resource "cloudflare_r2_bucket" "kafka_ts_offload" {
  provider   = cloudflare.r2
  account_id = var.cloudflare_account_id
  name       = local.kafka_ts_r2_bucket_name

  lifecycle {
    prevent_destroy = true
  }
}

# Incomplete MPU cleanup only — do not age-delete live tiered-storage objects.
resource "cloudflare_r2_bucket_lifecycle" "kafka_ts_offload_abort_mpu" {
  provider    = cloudflare.r2
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.kafka_ts_offload.name

  rules = [{
    id      = "abort-incomplete-multipart-1d"
    enabled = true
    conditions = {
      prefix = ""
    }
    abort_multipart_uploads_transition = {
      condition = {
        max_age = 86400
        type    = "Age"
      }
    }
  }]
}

# Long-lived dedicated Object RW account token scoped to the Kafka TS bucket only.
# Managing provider token must have Account API Tokens Write (not User API Tokens).
# Bucket Item Write includes object read/write/list; an extra Read grant is redundant.
# https://developers.cloudflare.com/r2/api/tokens/#permission-groups
resource "cloudflare_account_token" "kafka_ts_offload_object_rw" {
  provider   = cloudflare.r2
  account_id = var.cloudflare_account_id
  name       = "dofek-kafka-ts-offload-object-rw"

  policies = [{
    effect = "allow"
    permission_groups = [{
      id = data.cloudflare_account_api_token_permission_groups_list.r2_bucket_item_write.result[0].id
    }]
    resources = jsonencode({
      (local.kafka_ts_r2_bucket_resource) = "*"
    })
  }]

  depends_on = [cloudflare_r2_bucket.kafka_ts_offload]
}

resource "infisical_secret" "kafka_tiered_storage_bucket" {
  name         = "KAFKA_TIERED_STORAGE_BUCKET"
  value        = cloudflare_r2_bucket.kafka_ts_offload.name
  env_slug     = "prod"
  workspace_id = local.infisical_project_id
  folder_path  = "/"
}

resource "infisical_secret" "kafka_tiered_storage_endpoint" {
  name         = "KAFKA_TIERED_STORAGE_ENDPOINT"
  value        = local.kafka_ts_r2_endpoint
  env_slug     = "prod"
  workspace_id = local.infisical_project_id
  folder_path  = "/"
}

resource "infisical_secret" "kafka_tiered_storage_region" {
  name         = "KAFKA_TIERED_STORAGE_REGION"
  value        = local.kafka_ts_r2_region
  env_slug     = "prod"
  workspace_id = local.infisical_project_id
  folder_path  = "/"
}

resource "infisical_secret" "kafka_tiered_storage_access_key_id" {
  name         = "KAFKA_TIERED_STORAGE_ACCESS_KEY_ID"
  value        = cloudflare_account_token.kafka_ts_offload_object_rw.id
  env_slug     = "prod"
  workspace_id = local.infisical_project_id
  folder_path  = "/"
}

# Token value is sensitive; SHA-256 is the S3 secret. Value lives in encrypted TF state only —
# no terraform output.
resource "infisical_secret" "kafka_tiered_storage_secret_access_key" {
  name         = "KAFKA_TIERED_STORAGE_SECRET_ACCESS_KEY"
  value        = sha256(cloudflare_account_token.kafka_ts_offload_object_rw.value)
  env_slug     = "prod"
  workspace_id = local.infisical_project_id
  folder_path  = "/"
}
