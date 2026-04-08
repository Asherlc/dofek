# Renders the infra-compose.yml template with secrets.
# CI runs `terraform apply` then reads the rendered output to push to Dokploy.
# No persistent state needed — this config has no resources, only an output.

variable "postgres_password" {
  type      = string
  sensitive = true
}

variable "axiom_api_token" {
  type      = string
  sensitive = true
}

variable "sentry_otlp_logs_endpoint" {
  type = string
}

variable "r2_endpoint" {
  type = string
}

variable "r2_access_key_id" {
  type      = string
  sensitive = true
}

variable "r2_secret_access_key" {
  type      = string
  sensitive = true
}

variable "expo_app_id" {
  type = string
}

variable "expo_access_token" {
  type      = string
  sensitive = true
}

variable "ota_jwt_secret" {
  type      = string
  sensitive = true
}

variable "ota_public_key_b64" {
  type      = string
  sensitive = true
}

variable "ota_private_key_b64" {
  type      = string
  sensitive = true
}

variable "db_data_path" {
  description = "Host path for DB data (empty = use Docker volume)"
  type        = string
  default     = ""
}

variable "db_backup_path" {
  description = "Host path for DB backups (empty = use Docker volume)"
  type        = string
  default     = ""
}

output "compose_rendered" {
  value     = templatefile("${path.module}/../dokploy/infra-compose.yml", {
    postgres_password         = var.postgres_password
    axiom_api_token           = var.axiom_api_token
    sentry_otlp_logs_endpoint = var.sentry_otlp_logs_endpoint
    r2_endpoint               = var.r2_endpoint
    r2_access_key_id          = var.r2_access_key_id
    r2_secret_access_key      = var.r2_secret_access_key
    expo_app_id               = var.expo_app_id
    expo_access_token         = var.expo_access_token
    ota_jwt_secret            = var.ota_jwt_secret
    ota_public_key_b64        = var.ota_public_key_b64
    ota_private_key_b64       = var.ota_private_key_b64
    ota_domain                = "ota.dofek.asherlc.com"
    db_data_path              = var.db_data_path
    db_backup_path            = var.db_backup_path
  })
  sensitive = true
}
