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

resource "cloudflare_r2_bucket" "web_assets" {
  account_id = var.cloudflare_account_id
  name       = "dofek-web-assets"
  location   = "WEUR"
}

resource "cloudflare_r2_custom_domain" "web_assets" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.web_assets.name
  domain      = "assets.dofek.fit"
  zone_id     = cloudflare_zone.dofek_fit.id
  enabled     = true
}

resource "cloudflare_r2_bucket_cors" "web_assets" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.web_assets.name

  rules = [{
    id = "public-web-assets"
    allowed = {
      origins = ["*"]
      methods = ["GET", "HEAD"]
      headers = ["*"]
    }
    max_age_seconds = 86400
  }]
}

resource "cloudflare_r2_bucket" "db_backups" {
  account_id = var.cloudflare_account_id
  name       = "dofek-db-backups"
  location   = "WEUR"
}

resource "cloudflare_r2_bucket" "metric_stream_archive" {
  account_id = var.cloudflare_account_id
  name       = "dofek-metric-stream-archive"
  location   = "WEUR"
}

resource "cloudflare_r2_bucket" "account_erasure_ledger" {
  account_id = var.cloudflare_account_id
  name       = "dofek-account-erasure-ledger"
  location   = "WEUR"
}

resource "cloudflare_r2_bucket_lock" "account_erasure_ledger" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.account_erasure_ledger.name

  rules = [{
    id      = "retain-account-erasure-intents-indefinitely"
    enabled = true
    prefix  = "account-erasure/v1/"
    condition = {
      type = "Indefinite"
    }
  }]
}

resource "cloudflare_r2_bucket" "exports" {
  account_id = var.cloudflare_account_id
  name       = "dofek-exports"
  location   = "WEUR"
}

resource "cloudflare_r2_bucket" "imports" {
  account_id = var.cloudflare_account_id
  name       = "dofek-imports"
  location   = "WEUR"
}

resource "cloudflare_r2_bucket_lifecycle" "db_backups_cleanup" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.db_backups.name

  rules = [{
    id      = "expire-database-backups"
    enabled = true
    conditions = {
      prefix = ""
    }
    delete_objects_transition = {
      condition = {
        max_age = 1814400
        type    = "Age"
      }
    }
    abort_multipart_uploads_transition = {
      condition = {
        max_age = 86400
        type    = "Age"
      }
    }
  }]
}

resource "cloudflare_r2_bucket_lifecycle" "metric_stream_archive_staging_cleanup" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.metric_stream_archive.name

  rules = [{
    id      = "expire-account-erasure-staging"
    enabled = true
    conditions = {
      prefix = "account-erasure-staging/"
    }
    delete_objects_transition = {
      condition = {
        max_age = 86400
        type    = "Age"
      }
    }
    abort_multipart_uploads_transition = {
      condition = {
        max_age = 86400
        type    = "Age"
      }
    }
  }]
}

resource "cloudflare_r2_bucket_cors" "imports" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.imports.name

  rules = [{
    id = "production-direct-uploads"
    allowed = {
      origins = [
        "https://dofek.asherlc.com",
        "https://dofek.fit",
        "https://www.dofek.fit",
        "https://dofek.live",
        "https://www.dofek.live",
      ]
      methods = ["PUT"]
      headers = ["content-type"]
    }
    expose_headers  = ["etag"]
    max_age_seconds = 3600
  }]
}

resource "cloudflare_r2_bucket_lifecycle" "imports_cleanup" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.imports.name

  rules = [{
    id      = "expire-raw-imports"
    enabled = true
    conditions = {
      prefix = "imports/"
    }
    delete_objects_transition = {
      condition = {
        max_age = 604800
        type    = "Age"
      }
    }
    abort_multipart_uploads_transition = {
      condition = {
        max_age = 86400
        type    = "Age"
      }
    }
  }]
}

resource "cloudflare_r2_bucket_lifecycle" "exports_cleanup" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.exports.name

  rules = [{
    id      = "expire-user-exports"
    enabled = true
    conditions = {
      prefix = "exports/"
    }
    delete_objects_transition = {
      condition = {
        max_age = 604800
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

resource "cloudflare_r2_bucket_lifecycle" "web_assets_cleanup" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.web_assets.name

  rules = [{
    id      = "expire-old-web-assets"
    enabled = true
    conditions = {
      prefix = "web/"
    }
    delete_objects_transition = {
      condition = {
        max_age = 7776000
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

# NOTE: S3-compatible API credentials for R2 must be created manually in
# the Cloudflare dashboard. Store R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY
# in Infisical.
