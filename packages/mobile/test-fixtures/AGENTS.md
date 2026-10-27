# Native fixture agent instructions

Read [README.md](./README.md) before editing these fixtures.

- Use synthetic inputs only; never paste device/account data into fixtures.
- Exercise the installed production Swift through the
  [TypeScript runner](../../../scripts/test-apple-auth-diagnostics.ts); do not
  replace executable coverage with patch-text assertions.
- Update dependencies with [pnpm patch-commit](https://pnpm.io/cli/patch-commit)
  so changes survive installation; never edit installed production files as
  the durable fix.
