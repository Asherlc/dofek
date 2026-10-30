# Cross-source matching evaluation

Research snapshot: 2026-10-30. This document evaluates techniques against
repository fixtures; it does not change matching behavior or establish new
cross-provider identities. Fixtures below are constructed examples from tests,
not independently verified production matches or a measured accuracy benchmark.

## Distinguish the question being answered

| Question | Existing evidence and behavior |
| --- | --- |
| Does another catalogue describe this climb? | [ClimbingCatalogueService](../src/climbing-catalogue.ts) returns `source`, `corroborated`, or `possible` context. It caches results without persisting identities or importing candidate facts into the recorded climb. |
| Should entries share a display section? | [Area grouping](../packages/training/src/climbing-log-groups.ts) compares normalized full area-name paths and preserves ambiguous same-provider area identities. A display group is not an identity assertion. |
| Do recordings describe the same activity occurrence? | [Duplicate activity matching](../analytics/models/read_models/activity_duplicate_matches.sql) uses user, type, provider constraints, and temporal overlap. |
| Are separate activities comparable repetitions? | [Performance comparison fixtures](../packages/server/src/repositories/performance-comparison-identity.test.ts) distinguish exact namespaced identities, weak name evidence, and inferred route geometry. Separate occurrences can share a route. |
| Which nutrition records may contribute to a total? | [Canonical nutrition fixtures](../packages/server/src/repositories/nutrition-canonical.integration.test.ts) distinguish source accounts and contribution grain, preserve provenance, and expose unresolved source conflicts. Source selection does not require proving each item is a duplicate. |

## Existing evaluation cases

The expected results describe the cited tests. They are a baseline for preserving
intent, not proof that every existing rule is optimal.

| ID | Fixture evidence | Expected result | Technique this exercises |
| --- | --- | --- | --- |
| C1 | Recorded theCrag provider/ID matches a candidate whose name has changed. | `source` | Namespaced source identity survives renaming. |
| C2 | Kaya and theCrag `Cragmont Crack`, outdoor route, same `Cragmont Park` area coordinates; one candidate and complete search. | `corroborated` | Multiple independent attributes and candidate uniqueness. |
| C3 | C2 but search is incomplete, or two distinct candidate IDs survive. | `possible` | Observed uniqueness is insufficient when retrieval is incomplete; multiple candidates retain ambiguity. |
| C4 | Same climb/area names but candidate coordinates are `(10, 10)` instead of `(37.8921, -122.2637)`. | `possible` | Geographic conflict blocks corroboration while preserving the candidate. |
| C5 | Matching names with indoor setting, unknown setting, or unknown/mismatched kind. | `possible` | Reused names and incomplete classification weaken identity evidence. |
| C6 | Case and repeated whitespace differ; separately, `Masse` and `Maße` differ. | Formatting variants corroborate with other evidence; distinct names are filtered out. | Conservative normalization rather than destructive transliteration. |
| A1 | Mountain Project and OpenBeta paths normalize to `Donner Summit / Green Phantom Rock`. | One display group, all entries retained. | Hierarchy-aware presentation grouping. |
| A2 | `North Canyon / Wall` versus `South Canyon / Wall`. | Separate groups. | Parent context disambiguates common leaf names. |
| A3 | Two Mountain Project area identities share `Gym / Wall`; OpenBeta supplies a third matching path. | All three remain separate regardless of input order. | Avoid ambiguous cross-source bridges. |
| T1 | Same-provider Wahoo `other` activity at 15:22–16:05 and cycling activity at 15:21:24–16:13:42 on the same day. | Duplicate edge. | Temporal overlap plus an allowed type/provider relationship. |
| T2 | Wahoo `other` at 18:10–18:50 inside Peloton cycling at 18:00–19:00. | No duplicate connection between those activities. | Strong time containment alone does not override incompatible source/type evidence. |
| R1 | Anchor route and two routes shifted in opposite longitude directions by 0.0008°. | Anchor and one candidate selected, not all three. | Mutual compatibility rather than unrestricted similarity chaining. |
| R2 | Same route points in reverse order, with available geometry and compatible modality. | Inferred route match with `reverse` direction and quality/provenance. | Geometry and direction are richer evidence than a name. |
| R3 | Same exact identity value in a different provider namespace; or conflicting exact values. | Different namespace does not match; unresolved exact conflicts throw. | Identifier namespace and explicit conflict handling. |
| N1 | Meal totals 400 and 600 from account `account-a`, whose display name changes. | One source contributes 1,000 intake calories. | Stable account identity over display text. |
| N2 | Account key `a` versus source display name `account:a`. | Separate sources and `source_conflict`. | Typed namespaces prevent accidental string-key collisions. |

Sources: C1–C6 [catalogue tests](../src/climbing-catalogue.test.ts);
A1–A3 [area grouping tests](../packages/training/src/climbing-log-groups.test.ts);
T1–T2 [duplicate activity integration fixtures](../analytics/models/read_models/activity_duplicate_matches.integration.test.ts);
R1–R3 [performance comparison tests](../packages/server/src/repositories/performance-comparison-identity.test.ts);
N1 [nutrition integration tests](../packages/server/src/repositories/nutrition-canonical.integration.test.ts);
N2 [source namespace integration tests](../packages/server/src/repositories/nutrition-source-key.integration.test.ts).

## Research applied to these cases

| Technique | External precedent | Assessment for Dofek |
| --- | --- | --- |
| Candidate generation followed by scoring and clustering | Overture's places pipeline reuses historical matches, blocks candidate pairs, applies ML matching, and clusters results. [Official guide](https://docs.overturemaps.org/guides/places/) | Useful structure for catalogue research. Candidate retrieval needs evaluation separately from classification: a scorer cannot recover an alias excluded before scoring. C3 demonstrates why search completeness matters. |
| Probabilistic evidence with value-frequency adjustments | Splink adjusts evidence so agreement on rare values carries more weight than agreement on common values. [Official explanation](https://moj-analytical-services.github.io/splink/topic_guides/comparisons/term-frequency.html) | A candidate for common names such as `Wall`, after labeled examples exist. Avoid assuming a rare name alone establishes identity. |
| Field comparisons and active learning | Dedupe learns field weights with regularized logistic regression and requests labels for pairs where its classifier and blocking rules disagree. [Official explanation](https://docs.dedupe.io/en/latest/how-it-works/Matching-records.html) | Applicable when corrections and labeled pairs are available. It offers a way to concentrate review on informative cases rather than label random pairs. |
| Learned text pair classification | Ditto fine-tunes pretrained transformers for entity matching. [Original paper](https://arxiv.org/abs/2004.00584) | Worth evaluating only if name/description variation causes measured misses. Existing fixtures do not establish a need for a language-model service. |
| Sequence-aware spatial matching | Newson and Krumm use a hidden Markov model to infer road routes from noisy, sparse GPS sequences. [Original research](https://www.microsoft.com/en-us/research/publication/hidden-markov-map-matching-noise-sparseness/) | Relevant to observed traces and route networks. It does not directly solve catalogue identity when inputs contain only a name and one approximate area coordinate. |
| Matching separate from source selection | Overture promotes a source place after clustering rather than merging matched attributes. [Official guide](https://docs.overturemaps.org/guides/places/) | Retain this separation conceptually: finding a matching route does not establish which source grade, location, or tag should be used. Nutrition contribution selection is another distinct decision. |

Assessments in the right column are engineering inferences from the cited
techniques and repository cases, not measured improvements.

## Gaps to measure before selecting an implementation

The catalogue currently filters candidates to an exact provider/ID or an exact
normalized name. This excludes genuine aliases and typos if the provider search
returns them. Location corroboration compares each coordinate axis against
0.001 degrees; it does not compute distance in meters or distinguish coordinate
accuracy within the same scope. These are observed properties of the
[implementation](../src/climbing-catalogue.ts), not demonstrated production bugs.

The fixtures do not provide independently labeled examples of aliases, different
hierarchy depths, nearby distinct climbs with identical names, source copying,
or versioned indoor resets. They also cannot establish real-world precision,
recall, probability calibration, or an appropriate automatic-match threshold.
The current confidence labels are rule categories, not calibrated probabilities;
see the [catalogue decision logic](../src/climbing-catalogue.ts).

## Evaluation procedure

1. Define the target relationship for each evaluation: same catalogue entity,
   same occurrence, comparable route, display grouping, or contribution source.
   Keep the fixtures above separated by that relationship.
2. Collect permitted source pairs with provider/ID, retrieval date, original
   names, ancestry, coordinate scope, available type/setting, and candidate-search
   completeness. Preserve missing fields. Use minimal public or anonymized data.
3. Label each pair `same`, `different`, or `unresolved`, recording the evidence
   and reviewer. Keep uncertain cases unresolved rather than treating them as
   training truth. Include several candidates for ambiguous seeds.
4. Add clusters of three or more records, including misleading bridges. Evaluate
   results under different source orders and when evidence changes.
5. Measure candidate recall separately from decision precision/recall. Report
   automatic matches, rejected pairs, and abstentions separately, split by
   source pair and missingness. Inspect false merges at the cluster level.
6. Compare the existing rules with one narrowly scoped alternative on held-out
   entities/areas; keep related copies out of both training and evaluation splits.
   Choose acceptable error costs and coverage with product owners before setting
   automatic-match thresholds. These are proposed evaluation practices, not
   existing runtime behavior.

Recommendation: preserve existing exact identities and explicit ambiguity while
building the labeled evaluation set. Start any implementation proposal from the
observed error category. This fixture review does not justify a universal matcher,
a new persistent identity graph, or a learned-model dependency.
