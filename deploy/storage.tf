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

resource "cloudflare_r2_custom_domain" "storybook_preview" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.storybook.name
  domain      = "storybook.dofek.fit"
  enabled     = true
  zone_id     = cloudflare_zone.dofek_fit.id
}

# NOTE: S3-compatible API credentials for R2 must be created manually in
# the Cloudflare dashboard. Store R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY
# in Infisical.
