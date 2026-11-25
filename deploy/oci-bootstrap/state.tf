data "oci_objectstorage_namespace" "state" {
  compartment_id = var.tenancy_ocid
}

resource "oci_objectstorage_bucket" "state" {
  compartment_id = var.tenancy_ocid
  namespace      = data.oci_objectstorage_namespace.state.namespace
  name           = "dofek-terraform-state"
  access_type    = "NoPublicAccess"
  storage_tier   = "Standard"
  versioning     = "Enabled"

  lifecycle {
    prevent_destroy = true
  }
}

locals {
  state_bucket_name = oci_objectstorage_bucket.state.name
  state_key         = "host/terraform.tfstate"
  state_lock_key    = "${local.state_key}.lock"
  deploy_group_name = oci_identity_group.deploy.name
}

resource "oci_identity_policy" "state" {
  name           = "dofek-terraform-state"
  description    = "Grants the deploy group scoped access to the Terraform state bucket and lock object."
  compartment_id = var.tenancy_ocid

  statements = [
    "Allow group ${local.deploy_group_name} to inspect objects in tenancy where target.bucket.name = '${local.state_bucket_name}'",
    "Allow group ${local.deploy_group_name} to manage objects in tenancy where all {target.bucket.name = '${local.state_bucket_name}', target.object.name = '${local.state_key}', any {request.permission = 'OBJECT_INSPECT', request.permission = 'OBJECT_READ', request.permission = 'OBJECT_CREATE', request.permission = 'OBJECT_OVERWRITE'}}",
    "Allow group ${local.deploy_group_name} to manage objects in tenancy where all {target.bucket.name = '${local.state_bucket_name}', target.object.name = '${local.state_lock_key}', any {request.permission = 'OBJECT_INSPECT', request.permission = 'OBJECT_READ', request.permission = 'OBJECT_CREATE', request.permission = 'OBJECT_DELETE'}}",
  ]
}

output "state_bucket_name" {
  description = "Name of the Terraform state bucket."
  value       = oci_objectstorage_bucket.state.name
}

output "state_bucket_namespace" {
  description = "Object Storage namespace of the Terraform state bucket."
  value       = data.oci_objectstorage_namespace.state.namespace
}
