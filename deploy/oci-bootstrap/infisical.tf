provider "infisical" {}

variable "infisical_org_id" {
  description = "Infisical organization that owns the OCI deploy project."
  type        = string
}

resource "infisical_project" "oci_deploy" {
  name                       = "Dofek OCI Terraform"
  slug                       = "dofek-oci-terraform"
  type                       = "secret-manager"
  should_create_default_envs = true
}

resource "infisical_identity" "oci_deploy" {
  name   = "Dofek OCI Terraform"
  org_id = var.infisical_org_id
  role   = "no-access"
}

resource "infisical_project_identity" "oci_deploy" {
  project_id  = infisical_project.oci_deploy.id
  identity_id = infisical_identity.oci_deploy.id
  roles = [{
    role_slug = "viewer"
  }]
}

resource "infisical_identity_oidc_auth" "oci_deploy" {
  identity_id          = infisical_identity.oci_deploy.id
  oidc_discovery_url   = "https://token.actions.githubusercontent.com"
  bound_issuer         = "https://token.actions.githubusercontent.com"
  bound_audiences      = ["https://github.com/Asherlc"]
  bound_subject        = "repo:Asherlc/dofek:environment:terraform"
  access_token_ttl     = 600
  access_token_max_ttl = 600

  bound_claims = {
    event_name    = "workflow_dispatch"
    repository_id = "1177459554"
    ref           = "refs/heads/main"
    workflow_ref  = "Asherlc/dofek/.github/workflows/oci-terraform.yml@refs/heads/main"
  }
}

output "infisical_project_id" {
  description = "Project that stores the OCI deploy credential."
  value       = infisical_project.oci_deploy.id
}

output "infisical_identity_id" {
  description = "Machine identity authorized for the OCI deploy workflow."
  value       = infisical_identity.oci_deploy.id
}
