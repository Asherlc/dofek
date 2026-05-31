variable "hcloud_token" {
  type      = string
  sensitive = true
}

variable "ssh_public_key" {
  description = "SSH public key for server access"
  type        = string
}

variable "ssh_private_key" {
  description = "SSH private key for provisioner connections"
  type        = string
  sensitive   = true
}

variable "ssh_allowed_ips" {
  description = "CIDR blocks allowed to SSH"
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
}

variable "staging_data_volume_size_gb" {
  description = "Hetzner block storage size in GB for staging persistent data (set 0 to disable)"
  type        = number
  default     = 100
}

variable "staging_data_volume_name" {
  description = "Hetzner block storage volume name for staging"
  type        = string
  default     = "dofek-staging-data"
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

variable "oracle_server_host" {
  description = "Reserved public IP of the Oracle Cloud production host. Provisioned in deploy/oracle-free and mirrored here as the ORACLE_SERVER_HOST GitHub Actions variable."
  type        = string

  validation {
    condition     = can(regex("^([0-9]{1,3}\\.){3}[0-9]{1,3}$", var.oracle_server_host))
    error_message = "oracle_server_host must be a valid IPv4 address."
  }
}
