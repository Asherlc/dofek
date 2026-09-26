import type { Database } from "dofek/db";
import type { Request, Response } from "express";
import type { Provider } from "oidc-provider";
import { z } from "zod";
import { getSessionIdFromRequest } from "../../auth/cookies.ts";
import { validateSession } from "../../auth/session.ts";
import { getMcpIssuerUrl } from "../oauth-config.ts";
import { MCP_OAUTH_OFFLINE_ACCESS_SCOPE, MCP_SCOPE_LABELS } from "../oauth-provider.ts";

/**
 * Dofek-owned OAuth consent interaction for oidc-provider.
 *
 * oidc-provider delegates user login + consent to a custom interaction page
 * (its `devInteractions` feature is disabled here). This module supplies both
 * halves:
 *
 *   - `interactionUrl` — the destination oidc-provider redirects to when an
 *     authorization request requires login or consent. It resolves to Dofek's
 *     `/interaction/:uid` Express route.
 *   - `createInteractionHandler` — the Express handler for `/interaction/:uid`.
 *     It resolves the pending interaction via `provider.interactionDetails`,
 *     maps the Dofek session cookie to an oidc-provider account, and either
 *     (a) completes login transparently (the Dofek session is established
 *     before this route runs) or (b) renders the Dofek consent form and, on
 *     approval, persists the grant scope before finishing the interaction.
 */

const missingResourceScopesSchema = z.record(z.string(), z.array(z.string()));

const interactionDetailsSchema = z.object({
  uid: z.string(),
  prompt: z.object({
    name: z.string(),
    details: z
      .object({
        missingResourceScopes: missingResourceScopesSchema.optional(),
        missingOIDCScope: z.array(z.string()).optional(),
      })
      .default({}),
  }),
  params: z
    .object({
      client_id: z.string().optional(),
      scope: z.string().optional(),
    })
    .default({}),
  grantId: z.string().optional(),
});

type InteractionDetails = z.infer<typeof interactionDetailsSchema>;

const approvalBodySchema = z.object({
  approval: z.string().optional(),
});

const interactionUrlContextSchema = z.object({
  oidc: z.object({ issuer: z.string().optional() }).optional(),
});

export async function interactionUrl(ctx: unknown, interaction: { uid: string }): Promise<string> {
  const parsed = interactionUrlContextSchema.safeParse(ctx);
  const base = parsed.success
    ? (parsed.data.oidc?.issuer ?? getMcpIssuerUrl().href)
    : getMcpIssuerUrl().href;
  return new URL(`/interaction/${interaction.uid}`, base).href;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&"'<>]/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case '"':
        return "&quot;";
      case "'":
        return "&#039;";
      case "<":
        return "&lt;";
      default:
        return "&gt;";
    }
  });
}

function requestedScopes(interaction: InteractionDetails): string[] {
  const resourceMissing = Object.values(
    interaction.prompt.details.missingResourceScopes ?? {},
  ).flat();
  if (resourceMissing.length > 0) return resourceMissing;
  const missingOidc = interaction.prompt.details.missingOIDCScope;
  if ((missingOidc?.length ?? 0) > 0) return missingOidc ?? [];
  return (interaction.params.scope ?? "")
    .split(" ")
    .filter((scope) => scope.length > 0 && scope !== MCP_OAUTH_OFFLINE_ACCESS_SCOPE);
}

function scopeLabel(scope: string): string {
  for (const [known, label] of Object.entries(MCP_SCOPE_LABELS)) {
    if (known === scope) return label;
  }
  return scope;
}

function consentHtml(interaction: InteractionDetails): string {
  const clientId = interaction.params.client_id ?? "the MCP client";
  const scopes = requestedScopes(interaction);
  const scopeItems = scopes.map((scope) => `<li>${escapeHtml(scopeLabel(scope))}</li>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize ${escapeHtml(clientId)}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 36rem; margin: 4rem auto; padding: 0 1.5rem; color: #17202a; }
    .card { border: 1px solid #d5d8dc; border-radius: 0.75rem; padding: 1.5rem; }
    button { border: 0; border-radius: 0.5rem; cursor: pointer; font: inherit; padding: 0.75rem 1rem; }
    .approve { background: #17202a; color: white; }
    .deny { background: #eaeded; color: #17202a; }
    .actions { display: flex; gap: 0.75rem; margin-top: 1.5rem; }
  </style>
</head>
<body>
  <main class="card">
    <h1>Allow ${escapeHtml(clientId)} to access Dofek?</h1>
    <p>${escapeHtml(clientId)} is requesting these permissions:</p>
    <ul>${scopeItems}</ul>
    <form method="post" action="/interaction/${escapeHtml(interaction.uid)}">
      <div class="actions">
        <button class="approve" type="submit" name="approval" value="approve">Allow</button>
        <button class="deny" type="submit" name="approval" value="deny">Deny</button>
      </div>
    </form>
  </main>
</body>
</html>`;
}

export function createInteractionHandler(
  db: Pick<Database, "execute">,
  provider: Provider,
): (request: Request, response: Response) => Promise<void> {
  return async (request, response) => {
    const sessionId = getSessionIdFromRequest(request);
    const session = sessionId ? await validateSession(db, sessionId) : null;

    let interaction: InteractionDetails;
    try {
      const raw = await provider.interactionDetails(request, response);
      interaction = interactionDetailsSchema.parse(raw);
    } catch {
      response.status(400).send("Interaction not found");
      return;
    }

    if (interaction.prompt.name === "login") {
      if (!session) {
        const loginSearch = new URLSearchParams({ returnTo: request.originalUrl });
        response.redirect(`/login?${loginSearch}`);
        return;
      }
      await provider.interactionFinished(request, response, {
        login: { accountId: session.userId },
      });
      return;
    }

    if (interaction.prompt.name !== "consent") {
      await provider.interactionFinished(request, response, {
        error: "access_denied",
        error_description: "Unsupported interaction prompt",
      });
      return;
    }

    if (!session) {
      const loginSearch = new URLSearchParams({ returnTo: request.originalUrl });
      response.redirect(`/login?${loginSearch}`);
      return;
    }

    const approval = approvalBodySchema.safeParse(request.body).data?.approval;
    if (approval === "deny") {
      await provider.interactionFinished(request, response, {
        error: "access_denied",
        error_description: "End-user denied the request",
      });
      return;
    }

    if (approval === "approve") {
      const grantOptions = {
        accountId: session.userId,
        clientId: interaction.params.client_id,
      };
      const grant =
        interaction.grantId !== undefined
          ? ((await provider.Grant.find(interaction.grantId)) ?? new provider.Grant(grantOptions))
          : new provider.Grant(grantOptions);
      for (const [resource, scopes] of Object.entries(
        interaction.prompt.details.missingResourceScopes ?? {},
      )) {
        grant.addResourceScope(resource, scopes.join(" "));
      }
      const grantId = await grant.save();
      await provider.interactionFinished(
        request,
        response,
        { consent: { grantId } },
        { mergeWithLastSubmission: true },
      );
      return;
    }

    response.type("html").send(consentHtml(interaction));
  };
}
