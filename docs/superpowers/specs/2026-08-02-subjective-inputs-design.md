# Subjective Inputs Design

## Scope

Issue #2247 adds first-party, user-scoped subjective training and body-state inputs. The approved design is intentionally separate from provider body measurements, life events, and analytics.

## Storage

- `fitness.activity.perceived_exertion` remains the canonical per-session RPE value. It is nullable and constrained to the inclusive 0–10 range.
- `fitness.body_region` is a seeded reference hierarchy with stable text IDs, parent IDs, labels, and sort order. It includes bilateral hands, a separately modelled thumb, and A1–A5 pulley nodes for each non-thumb finger.
- `fitness.subjective_check_in` has one canonical row per `(user_id, date)`. Its presence means the user logged a check-in; no symptom rows means an explicit all-clear check-in.
- `fitness.subjective_symptom` stores only non-zero symptom reports: check-in ID, body-region ID, kind (`soreness`, `stiffness`, or `tenderness`), and an integer score from 1 through 10. Saving a check-in replaces that date's rows transactionally.
- `fitness.injury_event` stores user-owned injuries and niggles with a body-region reference, onset and optional resolution dates, integer severity 0–10, and a non-empty description. It is unrelated to `fitness.life_events`.

## Server contracts

`subjectiveRouter` owns region discovery, date-scoped check-in read/save, injury CRUD, and a date-window timeline. It delegates all SQL to a repository, applies `protectedProcedure`, validates every input/output with Zod, scopes every operation by `ctx.userId`, and invalidates only subjective cache keys.

`activityRouter` adds a user-scoped set/read contract for session RPE. A write resolves the requested visible activity to its canonical member row(s), writes only the requesting user's raw activity row(s), and exposes the chosen value through activity detail.

The MCP server exposes one read-only subjective timeline tool guarded by `health:read`; it returns raw check-ins, symptoms, and injury events without computing readiness, trends, or diagnosis.

## Client experience

The web Tracking page and mobile Recovery tab provide equivalent controls to log or revise today's check-in, select body regions, add sparse symptoms, and create/manage injuries. Both activity-detail screens provide a 0–10 session-RPE control and display the saved value. Clients render server data and never calculate subjective scores.

## Testing

Tests cover database constraints and atomic upsert/replace semantics against Postgres, repository ownership boundaries, router validation and cache invalidation, MCP scope/output behavior, and both web and mobile error/success UI states. Each behavior follows a failing-test → minimal-implementation cycle.
