variable "hcloud_token" {
  type      = string
  sensitive = true
}

variable "ssh_private_key" {
  description = "SSH private key for review app server provisioning and front door route sync"
  type        = string
  sensitive   = true
}

variable "pr_number" {
  description = "Pull request number for this review app"
  type        = number
}

variable "review_base_domain" {
  description = "Base domain suffix for PR review apps"
  type        = string
  default     = "dofek.asherlc.com"
}

variable "front_door_host" {
  description = "SSH host or IP for the shared review-app front door"
  type        = string
}

variable "front_door_ipv4" {
  description = "IPv4 address of the shared review-app front door"
  type        = string
}

variable "server_type" {
  description = "Hetzner server type for review apps"
  type        = string
  default     = "cax11"
}

variable "location" {
  description = "Hetzner location for review apps"
  type        = string
  default     = "nbg1"
}
