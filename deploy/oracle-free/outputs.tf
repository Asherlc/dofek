output "instance_id" {
  description = "OCID of the provisioned compute instance"
  value       = oci_core_instance.dofek.id
}

output "public_ip" {
  description = "Public IP of the instance (point Cloudflare DNS / Traefik host rules here)"
  value       = oci_core_instance.dofek.public_ip
}

output "ssh_command" {
  description = "Convenience SSH command (default user is 'ubuntu' on Oracle Ubuntu images)"
  value       = "ssh ubuntu@${oci_core_instance.dofek.public_ip}"
}
