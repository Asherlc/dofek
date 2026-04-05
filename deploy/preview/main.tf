# Ephemeral preview environment — one Hetzner server per PR.
#
# Usage (from GitHub Actions):
#   cd deploy/preview
#   terraform init
#   terraform workspace select -or-create pr-${PR_NUMBER}
#   terraform apply -auto-approve -var="pr_number=${PR_NUMBER}" ...
#
# Teardown:
#   terraform destroy -auto-approve -var="pr_number=${PR_NUMBER}" ...
#   terraform workspace select default
#   terraform workspace delete pr-${PR_NUMBER}

terraform {
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.49"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }

  # State stored in Cloudflare R2 (S3-compatible) so it persists across GHA runs.
  # Configure via environment variables in the workflow:
  #   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL_S3
  backend "s3" {
    bucket = "dofek-training-data"
    key    = "terraform/preview/terraform.tfstate"
    region = "us-east-1" # R2 ignores region; use a valid value so Terraform doesn't reject it

    # R2 doesn't support these S3 features
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
    skip_region_validation      = true
  }
}

# ── Variables ────────────────────────────────────────────────────────────

variable "hcloud_token" {
  description = "Hetzner Cloud API token"
  type        = string
  sensitive   = true
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for dofek.fit"
  type        = string
}

variable "pr_number" {
  description = "Pull request number (used for naming and subdomain)"
  type        = number
}

variable "server_image_tag" {
  description = "Docker image tag for the server image (e.g., sha-abc1234)"
  type        = string
}

variable "ghcr_username" {
  description = "GitHub username for GHCR image pulls"
  type        = string
}

variable "ghcr_token" {
  description = "GitHub PAT with read:packages scope for pulling GHCR images"
  type        = string
  sensitive   = true
}

variable "ssh_public_key" {
  description = "SSH public key for server access"
  type        = string
}

variable "ssh_allowed_ips" {
  description = "CIDR blocks allowed to SSH (e.g. [\"1.2.3.4/32\"]). Defaults to all."
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token for DNS record management"
  type        = string
  sensitive   = true
}

# ── Providers ────────────────────────────────────────────────────────────

provider "hcloud" {
  token = var.hcloud_token
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# ── Locals ───────────────────────────────────────────────────────────────

locals {
  preview_domain = "pr-${var.pr_number}.preview.dofek.fit"
  server_name    = "dofek-preview-pr-${var.pr_number}"
  server_image   = "ghcr.io/asherlc/dofek:${var.server_image_tag}"
}

# ── SSH Key ──────────────────────────────────────────────────────────────

resource "hcloud_ssh_key" "preview" {
  name       = "dofek-preview-pr-${var.pr_number}"
  public_key = var.ssh_public_key
}

# ── Firewall ─────────────────────────────────────────────────────────────

resource "hcloud_firewall" "preview" {
  name = "dofek-preview-pr-${var.pr_number}"

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = var.ssh_allowed_ips
  }

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

# ── Server ───────────────────────────────────────────────────────────────

resource "hcloud_server" "preview" {
  name         = local.server_name
  image        = "ubuntu-24.04"
  server_type  = "cax11"
  location     = "nbg1"
  ssh_keys     = [hcloud_ssh_key.preview.id]
  firewall_ids = [hcloud_firewall.preview.id]

  user_data = templatefile("${path.module}/cloud-init.yml", {
    domain        = local.preview_domain
    ghcr_token    = var.ghcr_token
    ghcr_username = var.ghcr_username
    server_image  = local.server_image
    compose_content = templatefile("${path.module}/docker-compose.yml", {
      server_image = local.server_image
      domain       = local.preview_domain
    })
    caddy_content = templatefile("${path.module}/Caddyfile", {
      domain = local.preview_domain
    })
  })

  labels = {
    purpose    = "preview"
    pr_number  = tostring(var.pr_number)
    managed_by = "terraform"
  }
}

# ── DNS ──────────────────────────────────────────────────────────────────

resource "cloudflare_dns_record" "preview" {
  zone_id = var.cloudflare_zone_id
  type    = "A"
  name    = "pr-${var.pr_number}.preview"
  content = hcloud_server.preview.ipv4_address
  ttl     = 60
  proxied = false # Direct connection — Caddy handles TLS
}

# ── Outputs ──────────────────────────────────────────────────────────────

output "preview_url" {
  description = "URL of the preview environment"
  value       = "https://${local.preview_domain}"
}

output "server_ip" {
  description = "IPv4 address of the preview server"
  value       = hcloud_server.preview.ipv4_address
}
