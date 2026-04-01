terraform {
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.49"
    }
  }
}

variable "hcloud_token" {
  sensitive = true
}

variable "ssh_public_key" {
  description = "SSH public key for server access"
  type        = string
}

variable "domain" {
  description = "Domain name for the server (used in Caddy config)"
  type        = string
}

variable "ghcr_username" {
  description = "GitHub username for GHCR image pulls"
  type        = string
}

variable "ssh_allowed_ips" {
  description = "CIDR blocks allowed to SSH (e.g. [\"1.2.3.4/32\"]). Defaults to all."
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
}

variable "sops_age_key" {
  description = "SOPS age secret key for decrypting provider credentials"
  type        = string
  sensitive   = true
}

variable "ghcr_token" {
  description = "GitHub PAT with read:packages scope for pulling GHCR images"
  type        = string
  sensitive   = true
}

variable "data_volume_size_gb" {
  description = "Optional extra block storage volume size in GB (set to 0 to disable)"
  type        = number
  default     = 0
}

variable "data_volume_name" {
  description = "Hetzner block storage volume name when extra data storage is enabled"
  type        = string
  default     = "dofek-data"
}

locals {
  data_volume_mountpoint = var.data_volume_size_gb > 0 ? "/mnt/HC_Volume_${var.data_volume_name}" : ""
}

provider "hcloud" {
  token = var.hcloud_token
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

  user_data = templatefile("${path.module}/cloud-init.yml", {
    domain          = var.domain
    sops_age_key    = var.sops_age_key
    ghcr_token      = var.ghcr_token
    ghcr_username   = var.ghcr_username
    compose_content = file("${path.module}/docker-compose.yml")
    caddy_content   = file("${path.module}/Caddyfile")
    db_data_path    = local.data_volume_mountpoint != "" ? "${local.data_volume_mountpoint}/postgres" : ""
    db_backup_path  = local.data_volume_mountpoint != "" ? "${local.data_volume_mountpoint}/backups" : ""
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

output "server_ip" {
  value = hcloud_server.dofek.ipv4_address
}

output "server_ipv6" {
  value = hcloud_server.dofek.ipv6_address
}

output "data_volume_id" {
  value = try(hcloud_volume.dofek_data[0].id, null)
}

output "data_volume_linux_device" {
  value = try(hcloud_volume.dofek_data[0].linux_device, null)
}

output "data_volume_mountpoint" {
  value = local.data_volume_mountpoint != "" ? local.data_volume_mountpoint : null
}
