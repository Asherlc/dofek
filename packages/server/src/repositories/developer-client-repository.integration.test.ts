import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { hashSecret } from "../routes/external-write-api-primitives.ts";
import { DeveloperClientRepository } from "./developer-client-repository.ts";

const firstOwnerId = "00000000-0000-4000-8000-000000000301";
const secondOwnerId = "00000000-0000-4000-8000-000000000302";
const administratorId = "00000000-0000-4000-8000-000000000303";

describe.sequential("DeveloperClientRepository", () => {
  let context: TestContext;
  let repository: DeveloperClientRepository;

  beforeAll(async () => {
    context = await setupTestDatabase();
    repository = new DeveloperClientRepository(context.db);
    await context.db.execute(sql`
      INSERT INTO fitness.user_profile (id, name, email, is_admin)
      VALUES
        (${firstOwnerId}, 'First Owner', 'first-owner@example.test', false),
        (${secondOwnerId}, 'Second Owner', 'second-owner@example.test', false),
        (${administratorId}, 'Support Admin', 'support-admin@example.test', true)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        email = EXCLUDED.email,
        is_admin = EXCLUDED.is_admin
    `);
  }, 120_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  it("creates a hashed owner-scoped client with canonical redirects and one audit event", async () => {
    const rawSecret = `raw-${randomUUID()}`;
    const created = await repository.createOwned(
      firstOwnerId,
      {
        name: "  Meal importer  ",
        redirectUris: ["https://client.example"],
        scopes: ["nutrition:write"],
      },
      hashSecret(rawSecret),
    );
    const { clientId } = created;

    expect(created).toMatchObject({
      name: "Meal importer",
      redirectUris: ["https://client.example/"],
      scopes: ["nutrition:write"],
      status: "active",
    });
    expect(clientId).toMatch(/^ext_[A-Za-z0-9_-]{24}$/);
    expect(new Date(created.lastRotatedAt).getTime()).toBeGreaterThan(0);
    await expect(repository.getOwned(firstOwnerId, clientId)).resolves.toEqual(created);
    await expect(repository.getOwned(secondOwnerId, clientId)).resolves.toBeNull();
    await expect(repository.getOwned(firstOwnerId, `ext_${randomUUID()}`)).resolves.toBeNull();
    expect((await repository.listOwned(firstOwnerId)).map((client) => client.clientId)).toContain(
      clientId,
    );
    expect(
      (await repository.listOwned(secondOwnerId)).map((client) => client.clientId),
    ).not.toContain(clientId);

    const stored = await context.db.execute<{
      action: string;
      actor_user_id: string;
      redirect_uri: string;
      secret_hash: string;
    }>(sql`
      SELECT
        client.secret_hash,
        redirect.redirect_uri,
        audit.action,
        audit.actor_user_id
      FROM fitness.external_client AS client
      JOIN fitness.external_client_redirect_uri AS redirect
        ON redirect.client_id = client.client_id
      JOIN fitness.external_client_audit AS audit
        ON audit.client_id = client.client_id
      WHERE client.client_id = ${clientId}
    `);
    expect(stored).toEqual([
      {
        action: "create",
        actor_user_id: firstOwnerId,
        redirect_uri: "https://client.example/",
        secret_hash: hashSecret(rawSecret),
      },
    ]);
    expect(stored[0]?.secret_hash).not.toBe(rawSecret);
  });

  it("replaces the full redirect set and records one update atomically", async () => {
    const created = await repository.createOwned(
      firstOwnerId,
      {
        name: "Original importer",
        redirectUris: ["https://client.example/first", "https://client.example/removed"],
        scopes: ["nutrition:write"],
      },
      hashSecret("original-secret"),
    );
    const { clientId } = created;

    const updated = await repository.updateOwned(firstOwnerId, clientId, {
      name: "  Updated importer  ",
      redirectUris: ["https://client.example/first", "https://client.example/new"],
    });
    expect(updated).toMatchObject({
      name: "Updated importer",
      redirectUris: ["https://client.example/first", "https://client.example/new"],
    });
    await expect(
      repository.updateOwned(secondOwnerId, clientId, {
        name: "Stolen importer",
        redirectUris: ["https://attacker.example/callback"],
      }),
    ).resolves.toBeNull();

    const rows = await context.db.execute<{ action: string; redirect_uris: string[] }>(sql`
      SELECT
        ARRAY(
          SELECT redirect_uri
          FROM fitness.external_client_redirect_uri
          WHERE client_id = ${clientId}
          ORDER BY redirect_uri
        ) AS redirect_uris,
        audit.action
      FROM fitness.external_client_audit AS audit
      WHERE audit.client_id = ${clientId}
      ORDER BY audit.occurred_at, audit.audit_id
    `);
    expect(rows).toEqual([
      {
        action: "create",
        redirect_uris: ["https://client.example/first", "https://client.example/new"],
      },
      {
        action: "update",
        redirect_uris: ["https://client.example/first", "https://client.example/new"],
      },
    ]);
  });

  it("rejects unsafe, duplicate, and empty redirect sets before writing", async () => {
    const input = {
      name: "Invalid importer",
      scopes: ["nutrition:write"] as const,
    };
    await expect(
      repository.createOwned(
        firstOwnerId,
        { ...input, redirectUris: ["http://client.example/callback"] },
        hashSecret("unsafe-secret"),
      ),
    ).rejects.toThrow("HTTPS");
    await expect(
      repository.createOwned(
        firstOwnerId,
        {
          ...input,
          redirectUris: ["https://client.example", "https://client.example/"],
        },
        hashSecret("duplicate-secret"),
      ),
    ).rejects.toThrow("unique");

    const created = await repository.createOwned(
      firstOwnerId,
      { ...input, redirectUris: ["https://client.example/callback"] },
      hashSecret("valid-secret"),
    );
    const { clientId } = created;
    await expect(
      repository.updateOwned(firstOwnerId, clientId, {
        name: "Invalid update",
        redirectUris: [],
      }),
    ).rejects.toThrow("at least one");
  });

  it("rotates the hash and timestamp in the same transaction as its audit", async () => {
    const created = await repository.createOwned(
      firstOwnerId,
      {
        name: "Rotated importer",
        redirectUris: ["https://client.example/rotate"],
        scopes: ["nutrition:write"],
      },
      hashSecret("before-rotation"),
    );
    const { clientId } = created;
    await context.db.execute(sql`SELECT pg_sleep(0.01)`);

    const rotated = await repository.rotateOwned(
      firstOwnerId,
      clientId,
      hashSecret("after-rotation"),
    );
    expect(rotated?.lastRotatedAt).not.toBe(created.lastRotatedAt);
    const rows = await context.db.execute<{ actions: string[]; secret_hash: string }>(sql`
      SELECT
        client.secret_hash,
        ARRAY(
          SELECT action
          FROM fitness.external_client_audit
          WHERE client_id = ${clientId}
          ORDER BY occurred_at, audit_id
        ) AS actions
      FROM fitness.external_client AS client
      WHERE client.client_id = ${clientId}
    `);
    expect(rows).toEqual([
      { actions: ["create", "rotate"], secret_hash: hashSecret("after-rotation") },
    ]);
  });

  it("revokes active grants, remains owner-readable, and rejects later mutations", async () => {
    const created = await repository.createOwned(
      firstOwnerId,
      {
        name: "Revoked importer",
        redirectUris: ["https://client.example/revoke"],
        scopes: ["nutrition:write"],
      },
      hashSecret("revoke-secret"),
    );
    const { clientId } = created;
    await context.db.execute(sql`
      INSERT INTO fitness.external_grant (
        client_id,
        user_id,
        namespace,
        subject,
        opaque_subject,
        access_token_hash,
        scopes,
        expires_at
      ) VALUES (
        ${clientId},
        ${firstOwnerId},
        'slack',
        ${randomUUID()},
        ${randomUUID()},
        ${hashSecret(randomUUID())},
        ARRAY['nutrition:write']::text[],
        now() + interval '15 minutes'
      )
    `);

    await expect(repository.revokeOwned(firstOwnerId, clientId)).resolves.toBe(true);
    await expect(repository.getOwned(firstOwnerId, clientId)).resolves.toMatchObject({
      status: "revoked",
    });
    await expect(
      repository.rotateOwned(firstOwnerId, clientId, hashSecret("later")),
    ).resolves.toBeNull();
    await expect(
      repository.updateOwned(firstOwnerId, clientId, {
        name: "Later update",
        redirectUris: ["https://client.example/later"],
      }),
    ).resolves.toBeNull();
    await expect(repository.revokeOwned(firstOwnerId, clientId)).resolves.toBe(false);

    const rows = await context.db.execute<{ actions: string[]; grant_revoked: boolean }>(sql`
      SELECT
        grant_record.revoked_at IS NOT NULL AS grant_revoked,
        ARRAY(
          SELECT action
          FROM fitness.external_client_audit
          WHERE client_id = ${clientId}
          ORDER BY occurred_at, audit_id
        ) AS actions
      FROM fitness.external_grant AS grant_record
      WHERE grant_record.client_id = ${clientId}
    `);
    expect(rows).toEqual([{ actions: ["create", "revoke"], grant_revoked: true }]);
  });

  it("lists support-safe owner attribution and records administrator revocation", async () => {
    const created = await repository.createOwned(
      secondOwnerId,
      {
        name: "Support importer",
        redirectUris: ["https://client.example/support"],
        scopes: ["nutrition:write"],
      },
      hashSecret("support-secret"),
    );
    const { clientId } = created;

    const client = (await repository.listForSupport()).find((item) => item.clientId === clientId);
    expect(client).toEqual({
      clientId,
      name: "Support importer",
      scopes: ["nutrition:write"],
      status: "active",
      createdAt: expect.any(String),
      lastRotatedAt: expect.any(String),
      ownerName: "Second Owner",
      ownerEmail: "second-owner@example.test",
    });
    expect(client).not.toHaveProperty("ownerUserId");
    expect(client).not.toHaveProperty("secretHash");
    expect(client).not.toHaveProperty("redirectUris");

    await expect(repository.revokeForSupport(administratorId, clientId)).resolves.toBe(true);
    const audits = await context.db.execute<{ action: string; actor_user_id: string }>(sql`
      SELECT action, actor_user_id
      FROM fitness.external_client_audit
      WHERE client_id = ${clientId}
      ORDER BY occurred_at, audit_id
    `);
    expect(audits).toEqual([
      { action: "create", actor_user_id: secondOwnerId },
      { action: "revoke", actor_user_id: administratorId },
    ]);
  });

  it("matches registered redirects exactly and cascades an erased owner", async () => {
    const ownerId = randomUUID();
    await context.db.execute(sql`
      INSERT INTO fitness.user_profile (id, name)
      VALUES (${ownerId}, 'Cascade Owner')
    `);
    const created = await repository.createOwned(
      ownerId,
      {
        name: "Cascade importer",
        redirectUris: ["https://client.example/callback"],
        scopes: ["nutrition:write"],
      },
      hashSecret("cascade-secret"),
    );
    const { clientId } = created;
    await expect(
      repository.hasExactRedirect(clientId, "https://client.example/callback"),
    ).resolves.toBe(true);
    await expect(
      repository.hasExactRedirect(clientId, "https://client.example/callback/"),
    ).resolves.toBe(false);
    await context.db.execute(sql`
      INSERT INTO fitness.external_link (
        client_id,
        redirect_uri,
        code_challenge,
        requested_scopes,
        expires_at,
        user_id
      ) VALUES (
        ${clientId},
        'https://client.example/callback',
        ${"a".repeat(43)},
        ARRAY['nutrition:write']::text[],
        now() + interval '10 minutes',
        ${ownerId}
      )
    `);
    await context.db.execute(sql`
      INSERT INTO fitness.external_grant (
        client_id,
        user_id,
        namespace,
        subject,
        opaque_subject,
        access_token_hash,
        scopes,
        expires_at
      ) VALUES (
        ${clientId},
        ${ownerId},
        'slack',
        ${randomUUID()},
        ${randomUUID()},
        ${hashSecret(randomUUID())},
        ARRAY['nutrition:write']::text[],
        now() + interval '15 minutes'
      )
    `);

    await context.db.execute(sql`DELETE FROM fitness.user_profile WHERE id = ${ownerId}`);
    const counts = await context.db.execute<{
      audit_count: number;
      client_count: number;
      grant_count: number;
      link_count: number;
      redirect_count: number;
    }>(sql`
      SELECT
        (SELECT count(*)::int FROM fitness.external_client
          WHERE client_id = ${clientId}) AS client_count,
        (SELECT count(*)::int FROM fitness.external_client_redirect_uri
          WHERE client_id = ${clientId}) AS redirect_count,
        (SELECT count(*)::int FROM fitness.external_client_audit
          WHERE client_id = ${clientId}) AS audit_count,
        (SELECT count(*)::int FROM fitness.external_link
          WHERE client_id = ${clientId}) AS link_count,
        (SELECT count(*)::int FROM fitness.external_grant
          WHERE client_id = ${clientId}) AS grant_count
    `);
    expect(counts).toEqual([
      {
        audit_count: 0,
        client_count: 0,
        grant_count: 0,
        link_count: 0,
        redirect_count: 0,
      },
    ]);
  });
});
