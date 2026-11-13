variable "cloudflare_api_token" {
  description = "Cloudflare API token for the default Terraform Cloudflare provider (Zone/DNS and existing storage.tf R2). Not used for Kafka TS account_token mint."
  type        = string
  sensitive   = true
}

variable "cloudflare_terraform_r2_api_token" {
  description = "Account-owned token for provider.cloudflare.r2 (Kafka TS R2 bucket/lifecycle + cloudflare_account_token mint). Permissions: Account API Tokens Write + Workers R2 Storage Write only — no DNS/Zone. GH secret CLOUDFLARE_TERRAFORM_R2_API_TOKEN; distinct from Infisical Traefik CLOUDFLARE_API_TOKEN. See deploy/kafka/README.md."
  type        = string
  sensitive   = true
}

variable "expo_app_id" {
  description = "Existing Infisical EXPO_APP_ID used by app-scoped OTA preview object keys"
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_-]+$", var.expo_app_id))
    error_message = "expo_app_id must be a nonempty OTA application identifier without path separators."
  }
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
