# theCrag Agent Guide

Read [README.md](README.md) first.

- Keep provider implementation modules in this directory; follow the [provider isolation rules](../AGENTS.md).
- Preserve safe route-method validation messages, and sanitize unexpected persistence errors as implemented in [persistence.ts](persistence.ts).
- Keep unit tests beside their source module and use the shared [provider test helpers](../test-helpers.ts).
