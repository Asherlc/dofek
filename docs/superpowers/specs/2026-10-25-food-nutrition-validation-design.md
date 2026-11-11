# Food nutrition validation

Approved direction: enforce nutrition consistency in the food-record service,
validate the complete effective result transactionally, and require explicit
source evidence for zero-calorie writes. The user approved skipping the GitHub
project-board update because the current token lacks project scopes.

The requirements and incident are recorded in [issue #3082](https://github.com/Asherlc/dofek/issues/3082).
Creation requires known calories, protein, carbohydrate, and fat. Preserve
source calories and reject contradictory new create/update results before
commit; retain request replay behavior and historical records. Use an
intentionally conservative protein/fat energy floor with label-rounding
allowance, excluding carbohydrate because fiber and sugar alcohols have
different energy factors. Labels permit rounding and specific energy factors
([21 CFR 101.9(c)](https://www.ecfr.gov/current/title-21/section-101.9#p-101.9(c)),
[USDA Handbook 74, table 13](https://www.ars.usda.gov/ARSUserFiles/80400525/Data/Classics/ah74.pdf)).

Require a nonempty `zeroCalorieEvidence` command field for zero-calorie writes
and retain it in the existing food description; expose it as
`zero_calorie_evidence` in MCP. Evidence must identify a label, manufacturer,
reliable database, or user-confirmed genuinely zero-calorie item. Evidence
cannot override an impossible macro combination. This avoids brittle food-name
allowlists and preserves water and other genuine zero-calorie items without
silently accepting numeric placeholders.

Alternatives considered: MCP-only checks miss direct service callers;
4/4/9 equality rejects legitimate labels; name/category heuristics cannot
reliably distinguish unknown nutrition from water. The approved service and
evidence approach uses the existing transaction and provenance storage.

No new dependencies, database columns, historical repairs, or client UI changes.
The MCP mutation boundary currently serves AI food-record writes; web/mobile
rendering remains server-owned. Test create/update, label discrepancies,
zero-calorie evidence, idempotency, rollback, and the exact cookies/shake
incident using a real Postgres daily-summary projection.
