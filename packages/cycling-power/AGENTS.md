# Cycling Power Package

Read [README.md](./README.md) first.

- Keep algorithms pure and dependency-free; callers supply numerical policy and calibration data.
- Do not add application identities, database clients, SQL, providers, wire contracts, or Dofek configuration.
- Test numerical behavior with unit fixtures.
- Application orchestration and calibration provenance belong to the consuming application.
