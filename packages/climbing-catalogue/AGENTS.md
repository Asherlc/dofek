# Climbing Catalogue Agent Guide

Read [README.md](README.md) first for the public contract and source references.

- Keep this library independent of Dofek application packages; callers own
  credentials, rate limiting, caches, jobs, persistence, and error reporting.
- Preserve root-to-leaf ancestry, source attribution, bounded discovery, and
  conservative identity evidence; see [matching](src/matching.ts).
- Keep independently runnable tests next to their source modules. Verify compiled
  exports with a packed installation before release; pnpm documents
  [publish configuration overrides](https://pnpm.io/package_json#publishconfig).
