# Reserved (static) public IP for the instance.
#
# An ephemeral public IP changes on every instance recreate, which breaks CI
# (the deploy job needs a stable SSH host) and DNS. A reserved public IP keeps
# the same address even when the instance is replaced: on recreate Terraform
# reassigns this reserved IP to the new VNIC's private IP, so the address —
# and therefore dofek-oracle.asherlc.com and the ORACLE_SERVER_HOST secret —
# never changes. Reserved public IPs are free within the Always Free tier.
#
# create_vnic_details.assign_public_ip is set to false in compute.tf so the
# private IP has no ephemeral public IP to conflict with this assignment.

data "oci_core_vnic_attachments" "dofek" {
  compartment_id = var.compartment_ocid
  instance_id    = oci_core_instance.dofek.id
}

data "oci_core_private_ips" "dofek" {
  vnic_id = data.oci_core_vnic_attachments.dofek.vnic_attachments[0].vnic_id
}

resource "oci_core_public_ip" "dofek" {
  compartment_id = var.compartment_ocid
  lifetime       = "RESERVED"
  private_ip_id  = data.oci_core_private_ips.dofek.private_ips[0].id
  display_name   = "dofek-reserved"
}
