# OCI Terraform access and state storage

This root manages the private, versioned `dofek-terraform-state` OCI bucket,
the OCI deploy identity and its public signing key, and the dedicated
`Dofek OCI Terraform` Infisical project and GitHub OIDC identity. The bootstrap
state uses `bootstrap/terraform.tfstate`. The host root uses
`host/terraform.tfstate` in the same bucket. Terraform acquires locks through
the native OCI Object Storage backend. [Terraform OCI backend](https://developer.hashicorp.com/terraform/language/backend/oci)

The deploy identity can read compute, volume, and network resources and update
existing security lists in the production compartment. Its storage permissions
allow it to read and write the host state and acquire and release its lock.
The bootstrap state is reserved for administrators. [OCI IAM object policies](https://docs.oracle.com/en-us/iaas/Content/Object/Tasks/managingobjects.htm#iam-policies-for-objects)

## Routine operations

Run the [OCI Terraform workflow](../../.github/workflows/oci-terraform.yml) on
`main` with the `plan` operation. The workflow exchanges a GitHub OIDC token
for read access to the dedicated Infisical project. The trust policy matches the
repository ID, workflow path, `main` ref, and workflow dispatch event.
The project's `prod` environment contains `OCI_TERRAFORM_PRIVATE_KEY` and
`OCI_TERRAFORM_INPUTS`. [Infisical GitHub OIDC](https://infisical.com/docs/documentation/platform/identities/oidc-auth/github)

## Administrator maintenance

Use an OCI administrator profile and an Infisical operator token. Set the
required Terraform variables `tenancy_ocid`, `infisical_org_id`, `deploy_email`,
and `public_key_path` through operator-local input. The email must be unique in
the OCI identity domain. The public key path points to the currently registered
RSA public key when checking the baseline. Record proposed registration or
rotation changes in the plan before applying. [OCI API signing keys](https://docs.oracle.com/en-us/iaas/Content/API/Concepts/apisigningkey.htm)

```bash
cd deploy/oci-bootstrap
export INFISICAL_AUTH_METHOD=token
export INFISICAL_TOKEN="$(infisical user get token --plain --silent)"
terraform init -backend-config=auth=SecurityToken \
  -backend-config=config_file_profile=DOFEK_BOOTSTRAP
terraform plan
unset INFISICAL_TOKEN
```

For a first deployment in a new tenancy, configure that tenancy's Object
Storage namespace and plan the bootstrap root in an isolated directory with
local state. After the private bucket exists, initialize the OCI backend with
`terraform init -migrate-state` and verify the resource IDs in remote state.
Existing deployments initialize against the existing remote state key.
[Terraform backend migration](https://developer.hashicorp.com/terraform/cli/commands/init#backend-initialization)
