# Agent Guidelines for @dofek/filter-columns

Read the [README.md](./README.md) first for the package contract and public API.

## Ownership

- Keep column classification and range-key parsing in `src/index.ts`; do not
  duplicate these naming rules in server or client code.
- Keep this package framework-neutral. SQL construction belongs in the server,
  and rendering belongs in the web or mobile client.
- Treat naming rules as a shared server/web contract. Before changing one,
  inspect both consumer surfaces for compatibility.

## Tests

- Update the colocated `src/index.test.ts` first for every behavior change.
- Cover exact recognized names, suffix boundaries, fallback behavior, and
  parsed range bounds through the public API.
- Run the package typecheck and focused unit test commands documented in the
  README.
