# Dedicated Cloudflare R2 bucket + long-lived Object RW key for Kafka tiered storage.
# Distinct from metric-stream archive and account-erasure ledger in storage.tf.
#
# Default OFF (`enable_kafka_tiered_storage_r2=false`): no bucket/key/secret create on apply
# until Root confirms (1) managing CLOUDFLARE_API_TOKEN can create account-owned tokens
# (Account API Tokens Write) and (2) CI Infisical write privilege for KAFKA_TIERED_STORAGE_*.
# Do not TF apply / deploy / mint keys from this lane without that ACK.
#
# Stock paths only — no custom JWT signer, no temp-credential renewal service.
# Account token: https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/account_token
# R2 S3 mapping: Access Key ID = token id; Secret = SHA-256(token value)
#   https://developers.cloudflare.com/r2/api/tokens/
# Bucket lifecycle MPU abort only (no live object age expiry) — GC is Kafka/RSM-owned.

locals {
  infisical_project_id        = "54712f56-98a9-4531-9e97-0b588d2e5a88"
  kafka_ts_r2_bucket_name     = "dofek-kafka-ts-offload"
  kafka_ts_r2_region          = "auto"
  kafka_ts_r2_endpoint        = "https://${var.cloudflare_account_id}.r2.cloudflarestorage.com"
  kafka_ts_r2_bucket_resource = "com.cloudflare.edge.r2.bucket.${var.cloudflare_account_id}_default_${local.kafka_ts_r2_bucket_name}"
  kafka_ts_r2_enabled         = var.enable_kafka_tiered_storage_r2
}

data "cloudflare_account_api_token_permission_groups_list" "r2_bucket_item_write" {
  count = local.kafka_ts_r2_enabled ? 1 : 0

  account_id = var.cloudflare_account_id
  # URL-encoded name per data-source docs.
  name  = "Workers%20R2%20Storage%20Bucket%20Item%20Write"
  scope = "com.cloudflare.edge.r2.bucket"
}

resource "cloudflare_r2_bucket" "kafka_ts_offload" {
  count = local.kafka_ts_r2_enabled ? 1 : 0

  account_id = var.cloudflare_account_id
  name       = local.kafka_ts_r2_bucket_name

  lifecycle {
    prevent_destroy = true
  }
}

# Incomplete MPU cleanup only — do not age-delete live tiered-storage objects.
resource "cloudflare_r2_bucket_lifecycle" "kafka_ts_offload_abort_mpu" {
  count = local.kafka_ts_r2_enabled ? 1 : 0

  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.kafka_ts_offload[0].name

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
# Managing token must have Account API Tokens Write (not User API Tokens).
resource "cloudflare_account_token" "kafka_ts_offload_object_rw" {
  count = local.kafka_ts_r2_enabled ? 1 : 0

  account_id = var.cloudflare_account_id
  name       = "dofek-kafka-ts-offload-object-rw"

  policies = [{
    effect = "allow"
    permission_groups = [{
      id = data.cloudflare_account_api_token_permission_groups_list.r2_bucket_item_write[0].result[0].id
    }]
    resources = jsonencode({
      (local.kafka_ts_r2_bucket_resource) = "*"
    })
  }]

  depends_on = [cloudflare_r2_bucket.kafka_ts_offload]
}

resource "infisical_secret" "kafka_tiered_storage_bucket" {
  count = local.kafka_ts_r2_enabled ? 1 : 0

  name         = "KAFKA_TIERED_STORAGE_BUCKET"
  value        = cloudflare_r2_bucket.kafka_ts_offload[0].name
  env_slug     = "prod"
  workspace_id = local.infisical_project_id
  folder_path  = "/"
}

resource "infisical_secret" "kafka_tiered_storage_endpoint" {
  count = local.kafka_ts_r2_enabled ? 1 : 0

  name         = "KAFKA_TIERED_STORAGE_ENDPOINT"
  value        = local.kafka_ts_r2_endpoint
  env_slug     = "prod"
  workspace_id = local.infisical_project_id
  folder_path  = "/"
}

resource "infisical_secret" "kafka_tiered_storage_region" {
  count = local.kafka_ts_r2_enabled ? 1 : 0

  name         = "KAFKA_TIERED_STORAGE_REGION"
  value        = local.kafka_ts_r2_region
  env_slug     = "prod"
  workspace_id = local.infisical_project_id
  folder_path  = "/"
}

resource "infisical_secret" "kafka_tiered_storage_access_key_id" {
  count = local.kafka_ts_r2_enabled ? 1 : 0

  name         = "KAFKA_TIERED_STORAGE_ACCESS_KEY_ID"
  value        = cloudflare_account_token.kafka_ts_offload_object_rw[0].id
  env_slug     = "prod"
  workspace_id = local.infisical_project_id
  folder_path  = "/"
}

resource "infisical_secret" "kafka_tiered_storage_secret_access_key" {
  count = local.kafka_ts_r2_enabled ? 1 : 0

  name         = "KAFKA_TIERED_STORAGE_SECRET_ACCESS_KEY"
  value        = sha256(cloudflare_account_token.kafka_ts_offload_object_rw[0].value)
  env_slug     = "prod"
  workspace_id = local.infisical_project_id
  folder_path  = "/"
}
