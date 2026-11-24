terraform {
  required_version = ">= 1.6"
  required_providers {
    fly = {
      source  = "ampbase-io/fly"
      version = "0.3.8"
    }
  }
}

provider "fly" {
  org_slug = var.fly_org
}

variable "fly_org" {
  type        = string
  description = "Fly organization slug (default: personal)"
  default     = "personal"
}

variable "app_name" {
  type        = string
  description = "Name of the Fly app"
}

variable "runner_image" {
  type        = string
  description = "Immutable runner image digest (e.g. registry/repo@sha256:...)"
  default     = null

  validation {
    condition     = var.runner_image == null || can(regex("^[^@[:space:]]+@sha256:[0-9a-f]{64}$", var.runner_image))
    error_message = "runner_image must be null or an image reference pinned with @sha256 and 64 lowercase hexadecimal characters."
  }
}

variable "production_sync" {
  type        = bool
  description = "Configure the Machine for the production provider-sync worker."
  default     = false
}

resource "fly_app" "runner" {
  name = var.app_name
}

resource "fly_machine" "runner" {
  count = var.runner_image == null ? 0 : 1

  app           = fly_app.runner.name
  name          = "pipeline-runner"
  image         = var.runner_image
  region        = "sjc"
  desired_state = "stopped"

  env = var.production_sync ? {
    ACCOUNT_ERASURE_LEDGER_R2_BUCKET = "dofek-account-erasure-ledger"
    DEPLOY_ENVIRONMENT               = "production"
    OTEL_EXPORTER_OTLP_ENDPOINT      = ""
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = "http://10.253.0.1:4318/v1/logs"
    OTEL_RESOURCE_ATTRIBUTES         = "deployment.environment=production"
    OTEL_SERVICE_NAME                = "dofek-worker"
    REDIS_URL                        = "redis://10.253.0.1:6379"
    SYNC_WORKER_SITE                 = "fly"
  } : {}

  guest {
    cpu_kind  = "shared"
    cpus      = 1
    memory_mb = 512
  }

  restart {
    policy = var.production_sync ? "on-failure" : "no"
  }

  dynamic "stop_config" {
    for_each = var.production_sync ? [1] : []
    content {
      signal  = "SIGTERM"
      timeout = "5m"
    }
  }

  dynamic "check" {
    for_each = var.production_sync ? [1] : []
    content {
      name         = "provider-sync-ready"
      port         = 3002
      type         = "http"
      method       = "GET"
      path         = "/readyz"
      interval     = "10s"
      timeout      = "3s"
      grace_period = "15s"
    }
  }

  lifecycle {
    # The canonical application release updates only the image on this Machine.
    ignore_changes = [image]
  }
}

output "app_name" {
  value = fly_app.runner.name
}

output "machine_id" {
  value = one(fly_machine.runner[*].id)
}
