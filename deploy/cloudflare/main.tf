terraform {
  cloud {
    organization = "dofek"
    workspaces {
      name = "dofek-cloudflare"
    }
  }
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token with Zone:Edit, DNS:Edit, and Workers R2 Storage:Edit permissions"
  type        = string
  sensitive   = true
}

variable "server_ip" {
  description = "Server IPv4 address (Hetzner) to point DNS records at"
  type        = string
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID (find at dash.cloudflare.com → any zone → Overview → right sidebar)"
  type        = string
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# --- dofek.fit ---

resource "cloudflare_zone" "dofek_fit" {
  account = {
    id = var.cloudflare_account_id
  }
  name = "dofek.fit"
}

resource "cloudflare_dns_record" "dofek_fit_root" {
  zone_id = cloudflare_zone.dofek_fit.id
  type    = "A"
  name    = "dofek.fit"
  content = var.server_ip
  proxied = true
  ttl     = 1
}

resource "cloudflare_dns_record" "dofek_fit_www" {
  zone_id = cloudflare_zone.dofek_fit.id
  type    = "CNAME"
  name    = "www.dofek.fit"
  content = "dofek.fit"
  proxied = true
  ttl     = 1
}

# --- dofek.live ---

resource "cloudflare_zone" "dofek_live" {
  account = {
    id = var.cloudflare_account_id
  }
  name = "dofek.live"
}

resource "cloudflare_dns_record" "dofek_live_root" {
  zone_id = cloudflare_zone.dofek_live.id
  type    = "A"
  name    = "dofek.live"
  content = var.server_ip
  proxied = true
  ttl     = 1
}

resource "cloudflare_dns_record" "dofek_live_www" {
  zone_id = cloudflare_zone.dofek_live.id
  type    = "CNAME"
  name    = "www.dofek.live"
  content = "dofek.live"
  proxied = true
  ttl     = 1
}

# --- asherlc.com (dofek subdomains) ---
# The asherlc.com zone already exists in Cloudflare; import it rather than creating it.
# Run: terraform import cloudflare_zone.asherlc_com <zone-id>

data "cloudflare_zone" "asherlc_com" {
  filter = {
    name = "asherlc.com"
  }
}

resource "cloudflare_dns_record" "ota_dofek_asherlc" {
  zone_id = data.cloudflare_zone.asherlc_com.zone_id
  type    = "A"
  name    = "ota.dofek.asherlc.com"
  content = var.server_ip
  proxied = false
  ttl     = 1
}

# --- R2 Storage ---

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

# NOTE: S3-compatible API credentials (access key ID + secret access key) for R2
# cannot be created via Terraform — they must be created manually in the
# Cloudflare dashboard: R2 → Manage R2 API Tokens → Create API Token.
# The existing token scoped to dofek-training-data must be updated to also
# cover dofek-ota, dofek-storybook, and dofek-db-backups (or create separate
# tokens per bucket). Then add R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY to
# Infisical (prod environment).
#
# After applying, configure Dokploy backups:
# 1. Dokploy → Settings → S3 Destinations → add R2 endpoint + credentials
# 2. Database service → Backups → add schedule pointing to dofek-db-backups

# --- Outputs ---

output "dofek_fit_nameservers" {
  description = "Set these as custom nameservers on Namecheap for dofek.fit"
  value       = cloudflare_zone.dofek_fit.name_servers
}

output "dofek_live_nameservers" {
  description = "Set these as custom nameservers on Namecheap for dofek.live"
  value       = cloudflare_zone.dofek_live.name_servers
}

output "r2_bucket_name" {
  description = "R2 bucket name for training data"
  value       = cloudflare_r2_bucket.training_data.name
}

output "r2_ota_bucket_name" {
  description = "R2 bucket name for OTA updates"
  value       = cloudflare_r2_bucket.ota.name
}

output "r2_storybook_bucket_name" {
  description = "R2 bucket name for Storybook previews"
  value       = cloudflare_r2_bucket.storybook.name
}

output "r2_db_backups_bucket_name" {
  description = "R2 bucket name for database backups (configure in Dokploy)"
  value       = cloudflare_r2_bucket.db_backups.name
}

output "r2_endpoint" {
  description = "R2 S3-compatible endpoint URL"
  value       = "https://${var.cloudflare_account_id}.r2.cloudflarestorage.com"
}

output "storybook_preview_base_url" {
  description = "Public base URL for PR Storybook previews"
  value       = "https://${cloudflare_r2_custom_domain.storybook_preview.domain}"
}
