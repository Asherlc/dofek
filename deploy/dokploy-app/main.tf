# Deploys the app (web + worker) to Dokploy and cleans up old images.
# CI passes the SHA-tagged image after pushing to GHCR.
#
# Usage: terraform apply -var="image_tag=sha-abc123"

variable "dokploy_host" {
  description = "Dokploy API base URL"
  type        = string
}

variable "dokploy_api_key" {
  description = "Dokploy API key"
  type        = string
  sensitive   = true
}

variable "web_app_id" {
  description = "Dokploy application ID for the web service"
  type        = string
}

variable "worker_app_id" {
  description = "Dokploy application ID for the worker service"
  type        = string
}

variable "image_tag" {
  description = "SHA-tagged image to deploy (e.g. sha-abc123)"
  type        = string
}

variable "registry" {
  description = "Container registry"
  type        = string
  default     = "ghcr.io"
}

variable "image_name" {
  description = "Image name without tag"
  type        = string
  default     = "asherlc/dofek"
}

locals {
  full_image = "${var.registry}/${var.image_name}:${var.image_tag}"
  app_ids    = [var.web_app_id, var.worker_app_id]
}

resource "terraform_data" "deploy" {
  for_each = toset(local.app_ids)

  triggers_replace = [var.image_tag]

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    command     = <<-EOT
      set -euo pipefail
      echo "Updating app ${each.value} image to ${local.full_image}..."
      curl -fsSL -X POST "${var.dokploy_host}/api/trpc/application.update" \
        -H "x-api-key: $DOKPLOY_API_KEY" \
        -H "Content-Type: application/json" \
        -d "{\"json\":{\"applicationId\":\"${each.value}\",\"sourceType\":\"docker\",\"dockerImage\":\"${local.full_image}\"}}"

      echo "Deploying app ${each.value}..."
      curl -fsSL -X POST "${var.dokploy_host}/api/trpc/application.deploy" \
        -H "x-api-key: $DOKPLOY_API_KEY" \
        -H "Content-Type: application/json" \
        -d "{\"json\":{\"applicationId\":\"${each.value}\"}}"
    EOT

    environment = {
      DOKPLOY_API_KEY = var.dokploy_api_key
    }
  }
}

resource "terraform_data" "cleanup" {
  depends_on = [terraform_data.deploy]

  triggers_replace = [var.image_tag]

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    command     = <<-EOT
      set -euo pipefail
      echo "Pruning unused Docker images..."
      curl -fsSL -X POST "${var.dokploy_host}/api/trpc/settings.cleanUnusedImages" \
        -H "x-api-key: $DOKPLOY_API_KEY" \
        -H "Content-Type: application/json" \
        -d '{"json":{}}' || echo "Image cleanup failed (non-fatal)"
    EOT

    environment = {
      DOKPLOY_API_KEY = var.dokploy_api_key
    }
  }
}
