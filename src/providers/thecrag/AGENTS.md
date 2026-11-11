# theCrag Agent Guide

Read [README.md](README.md) first.

- Keep provider implementation modules in this directory; follow the [provider isolation rules](../AGENTS.md).
- Follow the [nullable-method contract](../../../docs/climbing-context.md#attempts-and-interpretation), and sanitize unexpected persistence errors as implemented in [persistence.ts](persistence.ts).
- Keep unit tests beside their source module and use the shared [provider test helpers](../test-helpers.ts).
