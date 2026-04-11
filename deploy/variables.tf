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