# Unified Terraform config: Hetzner server, Cloudflare DNS/R2, TimescaleDB extension.
# Single workspace, single apply, single state.

terraform {
  cloud {
    organization = "dofek"
    workspaces {
      name = "dofek"
    }
  }
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.49"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
    postgresql = {
      source  = "cyrilgdn/postgresql"
      version = "~> 1.25"
    }
  }
}

# ── Variables ────────────────────────────────────────────────────────────

variable "hcloud_token" {
  type      = string
  sensitive = true
}

variable "ssh_public_key" {
  description = "SSH public key for server access"
  type        = string
}

variable "ssh_allowed_ips" {
  description = "CIDR blocks allowed to SSH"
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
}

variable "data_volume_size_gb" {
  description = "Optional Hetzner block storage size in GB (0 = disabled)"
  type        = number
  default     = 0
}

variable "data_volume_name" {
  description = "Hetzner block storage volume name"
  type        = string
  default     = "dofek-data"
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token with Zone:Edit, DNS:Edit, and Workers R2 Storage:Edit permissions"
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "postgres_password" {
  type      = string
  sensitive = true
}

# ── Providers ────────────────────────────────────────────────────────────

provider "hcloud" {
  token = var.hcloud_token
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

provider "postgresql" {
  host     = "127.0.0.1"
  port     = 5432
  database = "health"
  username = "health"
  password = var.postgres_password
  sslmode  = "disable"
}

# ── Server (Hetzner) ────────────────────────────────────────────────────

locals {
  data_volume_mountpoint = var.data_volume_size_gb > 0 ? "/mnt/HC_Volume_${var.data_volume_name}" : ""
}

resource "hcloud_ssh_key" "default" {
  name       = "dofek-deploy"
  public_key = var.ssh_public_key
}

resource "hcloud_firewall" "dofek" {
  name = "dofek"

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = var.ssh_allowed_ips
  }

  # HTTP/HTTPS for Traefik
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "80"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "443"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
}

resource "hcloud_server" "dofek" {
  name         = "dofek"
  image        = "ubuntu-24.04"
  server_type  = "cax11"
  location     = "nbg1"
  ssh_keys     = [hcloud_ssh_key.default.id]
  firewall_ids = [hcloud_firewall.dofek.id]

  user_data = templatefile("${path.module}/server/cloud-init.yml", {
    otel_collector_content = file("${path.module}/otel-collector-config.yaml")
  })
}

resource "hcloud_volume" "dofek_data" {
  count = var.data_volume_size_gb > 0 ? 1 : 0

  name      = var.data_volume_name
  size      = var.data_volume_size_gb
  server_id = hcloud_server.dofek.id
  format    = "ext4"
  automount = true
}

# ── Cloudflare (DNS + R2) ───────────────────────────────────────────────

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
  content = hcloud_server.dofek.ipv4_address
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

resource "cloudflare_dns_record" "dofek_fit_preview_wildcard" {
  zone_id = cloudflare_zone.dofek_fit.id
  type    = "A"
  name    = "*.preview.dofek.fit"
  content = hcloud_server.dofek.ipv4_address
  proxied = false
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
  content = hcloud_server.dofek.ipv4_address
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

data "cloudflare_zone" "asherlc_com" {
  filter = {
    name = "asherlc.com"
  }
}

resource "cloudflare_dns_record" "ota_dofek_asherlc" {
  zone_id = data.cloudflare_zone.asherlc_com.zone_id
  type    = "A"
  name    = "ota.dofek.asherlc.com"
  content = hcloud_server.dofek.ipv4_address
  proxied = false
  ttl     = 1
}

resource "cloudflare_dns_record" "portainer_dofek_asherlc" {
  zone_id = data.cloudflare_zone.asherlc_com.zone_id
  type    = "A"
  name    = "portainer.dofek.asherlc.com"
  content = hcloud_server.dofek.ipv4_address
  proxied = false
  ttl     = 1
}

resource "cloudflare_dns_record" "netdata_dofek_asherlc" {
  zone_id = data.cloudflare_zone.asherlc_com.zone_id
  type    = "A"
  name    = "netdata.dofek.asherlc.com"
  content = hcloud_server.dofek.ipv4_address
  proxied = false
  ttl     = 1
}

resource "cloudflare_dns_record" "databasus_dofek_asherlc" {
  zone_id = data.cloudflare_zone.asherlc_com.zone_id
  type    = "A"
  name    = "databasus.dofek.asherlc.com"
  content = hcloud_server.dofek.ipv4_address
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

# NOTE: S3-compatible API credentials for R2 must be created manually in
# the Cloudflare dashboard. Store R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY
# in Infisical.

# ── Database (TimescaleDB extension) ────────────────────────────────────
# CI opens an SSH tunnel (localhost:5432 → server:5432) before applying.

resource "postgresql_extension" "timescaledb" {
  name = "timescaledb"
}

# ── Outputs ─────────────────────────────────────────────────────────────

output "server_ip" {
  value = hcloud_server.dofek.ipv4_address
}

output "server_ipv6" {
  value = hcloud_server.dofek.ipv6_address
}

output "dofek_fit_nameservers" {
  description = "Set these as custom nameservers on Namecheap for dofek.fit"
  value       = cloudflare_zone.dofek_fit.name_servers
}

output "dofek_live_nameservers" {
  description = "Set these as custom nameservers on Namecheap for dofek.live"
  value       = cloudflare_zone.dofek_live.name_servers
}

output "r2_endpoint" {
  description = "R2 S3-compatible endpoint URL"
  value       = "https://${var.cloudflare_account_id}.r2.cloudflarestorage.com"
}
