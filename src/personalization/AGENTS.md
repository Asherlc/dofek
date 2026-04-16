# Personalization Agent Guide

> **Read the [README.md](./README.md) first** for the core architecture and features.

## Agent-Specific Information

### Development Rules
- **Independent Fitters**: Each personalization fitter must run independently. A failure in one (e.g., due to insufficient data) should not block others.
- **Data Minimums**: Respect `MIN_DAYS` or other data thresholds in each fitter.
- **Correlation Checks**: Only accept a fit if its correlation (e.g., between TSB and performance) meets a minimum quality threshold (`MIN_CORRELATION`).
- **Idempotency**: Refitting should be idempotent and only overwrite settings if the fit is successful.

### Testing Strategy
- **Unit Tests**: `<fitter>.test.ts` for verifying fitting logic with synthesized historical data.
- **Integration Tests**: `refit.integration.test.ts` for end-to-end refitting using real data from the database.
- **Parameter Validation**: `params.test.ts` for verifying Zod schemas and parameter consistency.

### Workflow
1. Add a new fitter (e.g., `fit-nutrition-targets.ts`).
2. Update `PersonalizedParams` in `params.ts`.
3. Integrate the new fitter into `refitAllParams` in `refit.ts`.
4. Implement data extraction SQL in `refit.ts`.
5. Add unit and integration tests for the new fitting logic.
