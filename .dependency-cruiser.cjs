/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // -- Package boundary rules --
    {
      name: "no-web-imports-mobile",
      comment: "packages/web must not import from packages/mobile",
      severity: "error",
      from: { path: "^packages/web/" },
      to: { path: "^packages/mobile/" },
    },
    {
      name: "no-mobile-imports-web",
      comment: "packages/mobile must not import from packages/web",
      severity: "error",
      from: { path: "^packages/mobile/" },
      to: { path: "^packages/web/" },
    },
    {
      name: "no-shared-imports-server",
      comment: "Shared domain packages must not import from server",
      severity: "error",
      from: {
        path: "^packages/(format|scoring|nutrition|training|stats|recovery|onboarding|providers-meta|zones|auth|heart-rate-variability)/",
      },
      to: { path: "^packages/server/" },
    },
    {
      name: "no-shared-imports-web",
      comment: "Shared domain packages must not import from web",
      severity: "error",
      from: {
        path: "^packages/(format|scoring|nutrition|training|stats|recovery|onboarding|providers-meta|zones|auth|heart-rate-variability)/",
      },
      to: { path: "^packages/web/" },
    },
    {
      name: "no-shared-imports-mobile",
      comment: "Shared domain packages must not import from mobile",
      severity: "error",
      from: {
        path: "^packages/(format|scoring|nutrition|training|stats|recovery|onboarding|providers-meta|zones|auth|heart-rate-variability)/",
      },
      to: { path: "^packages/mobile/" },
    },
    {
      name: "no-provider-cross-imports",
      comment: "Providers must not import from other providers (each is self-contained)",
      severity: "error",
      from: { path: "^src/providers/([^/]+)" },
      to: {
        path: "^src/providers/([^/]+)",
        pathNot: [
          // Allow importing from the same provider directory
          "^src/providers/$1",
          // Allow importing shared types, registry, and utilities
          "^src/providers/types\\.ts$",
          "^src/providers/index\\.ts$",
          "^src/providers/provider-model\\.ts$",
          "^src/providers/http-client\\.ts$",
        ],
      },
    },
    {
      name: "no-client-imports-root-src",
      comment: "Web and mobile packages should import from shared packages, not root src/ directly (except provider types and db)",
      severity: "warn",
      from: { path: "^packages/(web|mobile)/" },
      to: {
        path: "^src/",
        pathNot: [
          // Allow importing provider types, DB schema, and exports
          "^src/providers/types\\.ts$",
          "^src/db/",
          "^src/export\\.ts$",
        ],
      },
    },

    // -- Circular dependency detection --
    {
      name: "no-circular",
      comment: "No circular dependencies allowed",
      severity: "error",
      from: {},
      to: { circular: true },
    },

    // -- No importing dev dependencies in production code --
    {
      name: "no-dev-deps-in-prod",
      comment: "Production code must not import devDependencies",
      severity: "error",
      from: {
        path: "^(src|packages/[^/]+/src)/",
        pathNot: ["\\.test\\.tsx?$", "test-helpers\\.ts$", "fixtures/"],
      },
      to: { dependencyTypes: ["npm-dev"] },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: "tsconfig.json",
    },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
    reporterOptions: {
      text: {
        highlightFocused: true,
      },
    },
    exclude: {
      path: [
        "node_modules",
        "\\.test\\.tsx?$",
        "test-helpers\\.ts$",
        "fixtures/",
        "routeTree\\.gen\\.ts$",
        "drizzle/",
      ],
    },
  },
};
