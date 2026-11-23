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

  guest {
    cpu_kind  = "shared"
    cpus      = 1
    memory_mb = 512
  }

  restart {
    policy = "no"
  }
}

output "app_name" {
  value = fly_app.runner.name
}

output "machine_id" {
  value = one(fly_machine.runner[*].id)
}
