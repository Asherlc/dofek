import { describe, expect, it } from "vitest";
import {
  B2_IAC_PARENT_CAPABILITIES,
  buildBootstrapPacket,
  buildInfisicalMembershipPatchBody,
  buildInfisicalRoleMutationBody,
  buildOffloadSecretRolePermissions,
} from "./bootstrap-b2-pulsar-offload-iac.ts";

describe("bootstrap-b2-pulsar-offload-iac", () => {
  it("declares account-scoped IaC parent caps including writeKeys without listAllBucketNames", () => {
    expect(B2_IAC_PARENT_CAPABILITIES).toContain("writeKeys");
    expect(B2_IAC_PARENT_CAPABILITIES).toContain("writeBuckets");
    expect(B2_IAC_PARENT_CAPABILITIES).not.toContain("listAllBucketNames");
  });

  it("scopes Infisical secret write to PULSAR_OFFLOAD_B2_* in prod at /", () => {
    const permissions = buildOffloadSecretRolePermissions();
    expect(permissions).toHaveLength(1);
    expect(permissions[0]?.subject).toBe("secrets");
    expect(permissions[0]?.action).toEqual(["describeSecret", "readValue", "create", "edit"]);
    expect(permissions[0]?.conditions).toEqual({
      environment: { $eq: "prod" },
      secretPath: { $eq: "/" },
      secretName: { $glob: "PULSAR_OFFLOAD_B2_*" },
    });
  });

  it("membership patch keeps viewer and adds scoped role slug", () => {
    expect(buildInfisicalMembershipPatchBody()).toEqual({
      roles: [{ role: "viewer" }, { role: "gha-pulsar-offload-b2-secrets" }],
    });
  });

  it("print-packet payload has no secret fields", () => {
    const packet = buildBootstrapPacket();
    const serialized = JSON.stringify(packet);
    expect(serialized).not.toMatch(/applicationKey[^I]/i);
    expect(buildInfisicalRoleMutationBody().slug).toBe("gha-pulsar-offload-b2-secrets");
    expect(packet.githubSecretsViaStdin).toEqual(["B2_APPLICATION_KEY_ID", "B2_APPLICATION_KEY"]);
  });
});
