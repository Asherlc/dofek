# Standalone climbing catalogue

Approved scope: extract the full search and matching library as public npm package
`@dofek/climbing-catalogue`, independent of Dofek packages, and polish its public
API, tests, and documentation. The user approved this scope and name in chat.

## Approach

Extract schemas, conservative identity matching, native-first discovery, and the
Kaya, Mountain Project, theCrag, and OpenBeta catalogue adapters. A matcher-only
extraction would leave search coupled to Dofek; moving cache/jobs as well would
export application policy. The approved full-library boundary keeps credentials,
rate limiting, cache lifetimes, user/log IDs, and jobs in Dofek.

`ClimbingCatalogueSearch.search(seed)` returns attributed source results with
completeness, candidates, confidence, and evidence. Seeds contain climb facts,
not application identity. Adapters accept caller-supplied fetch and Kaya token
resolution. Errors propagate to the caller; Dofek remains responsible for Sentry.
No persisted identity, grade conversion, UI redesign, or new provider is added.

Retain existing discovery budgets, URL validation, nullable names, geographic
conflict protection, explicit references, and the distinction between fuzzy
suggestions and corroborated identity. Use existing Fuse.js, Zod, and Cheerio,
whose current stable releases were checked against the npm registry.

## Delivery

Publish compiled ESM and declarations with a root API and provider subpaths,
README examples, MIT license, and independent tests/build. Follow the repository's
[npm release workflow](../../../.github/workflows/release-npm.yml) and npm's
[package publication guidance](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages).
Verify a packed installation outside the monorepo before publication. Migrate
Dofek's server path and shared web/mobile contracts together.
