declare module "oidc-provider" {
  import type { Request, Response } from "express";

  interface OidcError extends Error {
    expose?: boolean;
    status?: number;
    statusCode?: number;
  }

  export const errors: {
    InvalidTarget: new (description?: string) => OidcError;
    [key: string]: new (...args: unknown[]) => OidcError;
  };

  interface Account {
    accountId: string;
    claims(...args: unknown[]): Promise<Record<string, unknown>>;
  }

  interface Adapter {
    upsert(id: string, payload: Record<string, unknown>, expiresIn?: number): Promise<void>;
    find(id: string): Promise<Record<string, unknown> | undefined>;
    findByUid(uid: string): Promise<Record<string, unknown> | undefined>;
    findByUserCode(userCode: string): Promise<Record<string, unknown> | undefined>;
    consume(id: string): Promise<void>;
    destroy(id: string): Promise<void>;
    revokeByGrantId(grantId: string): Promise<void>;
  }

  interface Grant {
    addResourceScope(resource: string, scope: string): void;
    save(expiresIn?: number): Promise<string>;
  }

  interface GrantConstructor {
    new (init: { accountId?: string; clientId?: string }): Grant;
    find(grantId: string): Promise<Grant | undefined>;
  }

  interface InteractionDetails {
    uid: string;
    prompt: {
      name: string;
      details: Record<string, unknown>;
    };
    params: Record<string, unknown>;
    grantId?: string;
    accountId?: string;
    [key: string]: unknown;
  }

  interface ConfigurableFeature {
    [key: string]: unknown;
  }

  interface RenderErrorContext {
    type: string;
    body: string;
  }

  interface ProviderConfiguration {
    scopes?: string[];
    features?: {
      ciba?: ConfigurableFeature;
      clientCredentials?: ConfigurableFeature;
      clientIdMetadataDocument?: ConfigurableFeature;
      deviceFlow?: ConfigurableFeature;
      devInteractions?: ConfigurableFeature;
      dPoP?: ConfigurableFeature;
      introspection?: ConfigurableFeature;
      pushedAuthorizationRequests?: ConfigurableFeature;
      registration?: ConfigurableFeature;
      resourceIndicators?: ConfigurableFeature;
      revocation?: ConfigurableFeature;
      userinfo?: ConfigurableFeature;
    };
    adapter?: (model: string) => Adapter;
    findAccount?: (
      ctx: unknown,
      accountId: string,
      token?: unknown,
    ) => Account | undefined | Promise<Account | undefined>;
    interactions?: {
      url?: (ctx: unknown, interaction: { uid: string }) => string | Promise<string>;
    };
    routes?: Record<string, string>;
    cookies?: { keys?: string[] };
    clientBasedCORS?: (ctx: unknown, origin: unknown, client: unknown) => boolean;
    renderError?: (ctx: RenderErrorContext, out: unknown, error: OidcError) => void;
  }

  export class Provider {
    constructor(issuer: string, configuration: ProviderConfiguration);
    callback(): (request: Request, response: Response, next?: () => void) => void;
    interactionDetails(request: Request, response: Response): Promise<Record<string, unknown>>;
    interactionFinished(
      request: Request,
      response: Response,
      result: Record<string, unknown>,
      options?: { mergeWithLastSubmission?: boolean },
    ): Promise<void>;
    Grant: GrantConstructor;
  }

  export { Provider as default };
}
