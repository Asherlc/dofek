# Dokploy service configuration.
# Manages app services (web, worker) as Dokploy-native applications
# and infrastructure (db, redis, otel, etc.) as a Compose stack.
#
# Prerequisites:
#   1. Server provisioned via main.tf
#   2. Dokploy admin account created at http://<ip>:3000
#   3. API token generated in Dokploy Settings → API

terraform {
  required_providers {
    dokploy = {
      source  = "ahmedali6/dokploy"
      version = "~> 0.5"
    }
  }
}

# ---------------------------------------------------------------------------
# Variables
# ---------------------------------------------------------------------------

variable "dokploy_host" {
  description = "Dokploy URL (e.g. https://dokploy.dofek.asherlc.com or http://<ip>:3000)"
  type        = string
}

variable "dokploy_api_key" {
  description = "Dokploy API token (Settings → API)"
  type        = string
  sensitive   = true
}

variable "ghcr_token" {
  description = "GitHub PAT with read:packages for pulling GHCR images"
  type        = string
  sensitive   = true
}

variable "postgres_password" {
  type      = string
  sensitive = true
}

variable "domain" {
  description = "Primary domain (e.g. dofek.asherlc.com)"
  type        = string
}

variable "additional_domains" {
  description = "Additional domains to route to the web app (e.g. dofek.fit, dofek.live)"
  type        = list(string)
  default     = ["dofek.fit", "www.dofek.fit", "dofek.live", "www.dofek.live"]
}

variable "ota_domain" {
  description = "OTA update server domain"
  type        = string
  default     = "ota.dofek.asherlc.com"
}

# Secrets (flattened from Infisical — set these in terraform.tfvars or via env)
variable "axiom_api_token" {
  type      = string
  sensitive = true
}

variable "sentry_otlp_traces_endpoint" {
  type    = string
  default = ""
}

variable "sentry_otlp_logs_endpoint" {
  type    = string
  default = ""
}

variable "slack_bot_token" {
  type      = string
  sensitive = true
  default   = ""
}

# OTA service secrets
variable "r2_endpoint" {
  type      = string
  sensitive = true
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
  type    = string
  default = ""
}

variable "ota_private_key_b64" {
  type      = string
  sensitive = true
  default   = ""
}

# App env vars (non-secret config from .env, flattened)
variable "app_env" {
  description = "Non-secret app env vars as KEY=VALUE map (OAuth client IDs, etc.)"
  type        = map(string)
  default     = {}
}

variable "db_data_path" {
  description = "Host path for TimescaleDB data (block storage mount). Empty = Docker volume."
  type        = string
  default     = ""
}

variable "db_backup_path" {
  description = "Host path for DB backups. Empty = Docker volume."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# Provider
# ---------------------------------------------------------------------------

provider "dokploy" {
  host    = var.dokploy_host
  api_key = var.dokploy_api_key
}

# ---------------------------------------------------------------------------
# GHCR Registry
# ---------------------------------------------------------------------------

resource "dokploy_registry" "ghcr" {
  registry_name = "GitHub Container Registry"
  registry_type = "cloud"
  registry_url  = "ghcr.io"
  username      = "asherlc"
  password      = var.ghcr_token
  image_prefix  = "ghcr.io/asherlc"
}

# ---------------------------------------------------------------------------
# Project + Environment
# ---------------------------------------------------------------------------

resource "dokploy_project" "dofek" {
  name        = "dofek"
  description = "Health data pipeline"
}

resource "dokploy_environment" "production" {
  project_id  = dokploy_project.dofek.id
  name        = "Production"
  description = "Production environment"
}

# ---------------------------------------------------------------------------
# Shared env vars (used by all app services)
# ---------------------------------------------------------------------------

# NOTE: Dokploy puts all project services on a shared overlay network.
# Compose service hostnames may be prefixed with the stack's app_name.
# After first deploy, verify with: docker network inspect dokploy-network
# and adjust db_host / redis_host / collector_host if needed.

locals {
  # These hostnames depend on how Dokploy names compose services.
  # Typical patterns: "db", "dofek-infra-db", or "<app_name>-db".
  # Start with bare names — Dokploy's compose usually uses these.
  db_host        = "db"
  redis_host     = "redis"
  collector_host = "collector"

  database_url = "postgres://health:${var.postgres_password}@${local.db_host}:5432/health"
  redis_url    = "redis://${local.redis_host}:6379"

  # Base env vars shared by all dofek app containers
  shared_env = merge(var.app_env, {
    DATABASE_URL                   = local.database_url
    REDIS_URL                      = local.redis_url
    NODE_ENV                       = "production"
    PUBLIC_URL                     = "https://${var.domain}"
    OTEL_EXPORTER_OTLP_ENDPOINT   = "http://${local.collector_host}:4318"
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT   = "http://${local.collector_host}:4318/v1/logs"
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = var.sentry_otlp_traces_endpoint
  })
}

# ---------------------------------------------------------------------------
# App: web (Dokploy-native — gets zero-downtime deploys, health checks)
# ---------------------------------------------------------------------------

resource "dokploy_application" "web" {
  name           = "dofek-web"
  environment_id = dokploy_environment.production.id
  source_type    = "docker"
  docker_image   = "ghcr.io/asherlc/dofek:latest"
  command        = "./entrypoint.sh web"

  env = join("\n", [for k, v in merge(local.shared_env, {
    PORT              = "3000"
    OTEL_SERVICE_NAME = "dofek-web"
    JOB_FILES_DIR     = "/app/job-files"
  }) : "${k}=${v}"])

  health_check_swarm = jsonencode({
    Test     = ["CMD-SHELL", "node -e \"fetch('http://localhost:3000/healthz').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))\""]
    Interval = 5000000000
    Timeout  = 3000000000
    Retries  = 5
  })

  update_config_swarm = jsonencode({
    Parallelism   = 1
    Delay         = 10000000000
    FailureAction = "rollback"
    Order         = "start-first"
  })

  restart_policy_swarm = jsonencode({
    Condition   = "any"
    MaxAttempts = 0
  })

  rollback_active = true

  deploy_on_create = true
}

resource "dokploy_mount" "web_job_files" {
  service_id   = dokploy_application.web.id
  service_type = "application"
  type         = "volume"
  volume_name  = "dofek-job-files"
  mount_path   = "/app/job-files"
}

# Primary domain
resource "dokploy_domain" "web_primary" {
  application_id   = dokploy_application.web.id
  host             = var.domain
  port             = 3000
  https            = true
  certificate_type = "letsencrypt"
}

# Additional domains (dofek.fit, dofek.live, etc.)
resource "dokploy_domain" "web_extra" {
  for_each = toset(var.additional_domains)

  application_id   = dokploy_application.web.id
  host             = each.value
  port             = 3000
  https            = true
  certificate_type = "letsencrypt"
}

# ---------------------------------------------------------------------------
# App: worker (Dokploy-native — long-running BullMQ worker)
# ---------------------------------------------------------------------------

resource "dokploy_application" "worker" {
  name           = "dofek-worker"
  environment_id = dokploy_environment.production.id
  source_type    = "docker"
  docker_image   = "ghcr.io/asherlc/dofek:latest"
  command        = "./entrypoint.sh worker"

  env = join("\n", [for k, v in merge(local.shared_env, {
    OTEL_SERVICE_NAME = "dofek-worker"
  }) : "${k}=${v}"])

  restart_policy_swarm = jsonencode({
    Condition   = "on-failure"
    MaxAttempts = 3
  })

  # Long stop grace period for in-progress sync jobs
  stop_grace_period_swarm = 2100000000000 # 35 minutes in nanoseconds

  deploy_on_create = true
}

resource "dokploy_mount" "worker_job_files" {
  service_id   = dokploy_application.worker.id
  service_type = "application"
  type         = "volume"
  volume_name  = "dofek-job-files"
  mount_path   = "/app/job-files"
}

# ---------------------------------------------------------------------------
# Infrastructure: Compose stack (db, redis, otel collector, backups, OTA)
# ---------------------------------------------------------------------------

resource "dokploy_compose" "infra" {
  name           = "dofek-infra"
  environment_id = dokploy_environment.production.id
  source_type    = "raw"

  compose_file_content = templatefile("${path.module}/infra-compose.yml", {
    postgres_password       = var.postgres_password
    axiom_api_token         = var.axiom_api_token
    sentry_otlp_logs_endpoint = var.sentry_otlp_logs_endpoint
    r2_endpoint             = var.r2_endpoint
    r2_access_key_id        = var.r2_access_key_id
    r2_secret_access_key    = var.r2_secret_access_key
    expo_app_id             = var.expo_app_id
    expo_access_token       = var.expo_access_token
    ota_jwt_secret          = var.ota_jwt_secret
    ota_public_key_b64      = var.ota_public_key_b64
    ota_private_key_b64     = var.ota_private_key_b64
    ota_domain              = var.ota_domain
    db_data_path            = var.db_data_path
    db_backup_path          = var.db_backup_path
  })

  env = join("\n", [
    "POSTGRES_PASSWORD=${var.postgres_password}",
  ])

  deploy_on_create = true
}

# ---------------------------------------------------------------------------
# Sync: scheduled one-shot (configure via Dokploy UI)
# ---------------------------------------------------------------------------
# The sync service enqueues provider sync jobs into BullMQ (processed by worker).
# After initial deploy, set up a scheduled job in Dokploy UI:
#   Project → dofek → Scheduled Jobs → Add
#   - Command: ./entrypoint.sh sync
#   - Container: dofek-web (or create a dedicated one-off container)
#   - Cron: 0 */6 * * *  (every 6 hours, adjust as needed)
#
# The ahmedali6/dokploy Terraform provider doesn't support schedules yet.
# If you need IaC for this, the TheFrozenFire/dokploy provider has
# dokploy_schedule, or you can hit the API directly:
#   curl -X POST ${var.dokploy_host}/api/trpc/schedule.create \
#     -H "Authorization: Bearer ${var.dokploy_api_key}" \
#     -d '{"json":{"cronExpression":"0 */6 * * *","command":"./entrypoint.sh sync",...}}'

# ---------------------------------------------------------------------------
# OTA domain routing
# ---------------------------------------------------------------------------
resource "dokploy_domain" "ota" {
  compose_id       = dokploy_compose.infra.id
  service_name     = "ota"
  host             = var.ota_domain
  port             = 3000
  https            = true
  certificate_type = "letsencrypt"
}
