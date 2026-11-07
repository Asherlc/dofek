variable "cloudflare_api_token" {
  description = "Cloudflare API token with Zone:Edit, DNS:Edit, and Workers R2 Storage:Edit. Enabling Kafka TS R2 also requires Account API Tokens Write for cloudflare_account_token (not User API Tokens)."
  type        = string
  sensitive   = true
}

variable "enable_kafka_tiered_storage_r2" {
  description = "When true, create dedicated dofek-kafka-ts-offload R2 bucket, Object RW account token, and KAFKA_TIERED_STORAGE_* Infisical secrets. Default false until Root confirms account-token auth + Infisical CI write privilege."
  type        = bool
  default     = false
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
