resource "cloudflare_r2_bucket" "training_data" {
  account_id = var.cloudflare_account_id
  name       = "dofek-training-data"
  location   = "WEUR"
}

resource "cloudflare_r2_bucket" "ota" {
  account_id = var.cloudflare_account_id
  name       = "dofek-ota"
  location   = "WEUR"
}

resource "cloudflare_r2_bucket" "storybook" {
  account_id = var.cloudflare_account_id
  name       = "dofek-storybook"
  location   = "WEUR"
}

resource "cloudflare_r2_bucket" "db_backups" {
  account_id = var.cloudflare_account_id
  name       = "dofek-db-backups"
  location   = "WEUR"
}

resource "cloudflare_r2_bucket_lifecycle" "storybook_preview_cleanup" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.storybook.name

  rules = [{
    id      = "expire-pr-previews"
    enabled = true
    conditions = {
      prefix = "pr-"
    }
    delete_objects_transition = {
      condition = {
        max_age = 1209600
        type    = "Age"
      }
    }
    abort_multipart_uploads_transition = {
      condition = {
        max_age = 604800
        type    = "Age"
      }
    }
  }]
}

resource "cloudflare_r2_bucket_lifecycle" "ota_preview_cleanup" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.ota.name

  rules = [{
    id      = "expire-pr-previews"
    enabled = true
    conditions = {
      prefix = "pr-"
    }
    delete_objects_transition = {
      condition = {
        max_age = 1209600
        type    = "Age"
      }
    }
    abort_multipart_uploads_transition = {
      condition = {
        max_age = 604800
        type    = "Age"
      }
    }
  }]
}

# Managed manually — cloudflare_r2_custom_domain does not support import.
# The storybook.dofek.fit custom domain is configured in the Cloudflare dashboard.
# Re-add this resource after the existing domain is removed or import is supported.

# NOTE: S3-compatible API credentials for R2 must be created manually in
# the Cloudflare dashboard. Store R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY
# in Infisical.
