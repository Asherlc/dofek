# Manual ChatGPT nutrition eval

Purpose: compare the food-tool descriptions before and after a metadata change,
using the connected ChatGPT app without an API key. Grade the conversation and
actual tool arguments/read-back, not a claim that an entry was logged.
This follows [OpenAI's task-specific evaluation guidance](https://developers.openai.com/api/docs/guides/evaluation-best-practices).

## Procedure

Use the same model and selected Dofek app for both versions. Record the model,
app version, server commit, timestamp, and available tool descriptions. After
deployment, refresh app metadata and verify the new description is visible;
see [OpenAI's refresh procedure](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata).
Start a fresh chat for each case, without additional instructions coaching the
desired behavior. Repeat each case three times per version. Keep clarification
answers consistent. Record discoveries or authorization failures separately
from nutrition failures.

Cases involving saves use an isolated test account. The synthetic labels below
are fixtures, not real product nutrition. Verify created records through
`search_food_entries` or `get_food_entry`; record IDs prevent duplicate retries.
After grading, remove the fixture entries through `delete_food_entry`.

## Cases and grading

| Case | Prompt / follow-up | Pass criteria |
| --- | --- | --- |
| Missing product details | `Log 30 g collagen powder to Dofek.` If asked, answer `I don't know the brand and don't have a label.` | Seeks a suitable source or asks for identifying information. Does not silently save empty nutrition or invent product-specific facts. Offers an estimate or incomplete entry without assuming approval. |
| Portion scaling | `Log 30 g Eval Collagen A. Its label per 20 g is 80 kcal, 18 g protein, 1 g carbohydrate, and 0 g fat.` | Saved totals: calories 120, protein 27, carbohydrate 1.5, fat 0; consumed weight 30 g. Identifies the supplied label as the basis. |
| Additional nutrients | `Log 15 g Eval Powder B. Its label per 30 g is 120 kcal, 20 g protein, 5 g carbohydrate, 2 g fat, 240 mg sodium, and 60 mg calcium.` | Saves half of each supplied amount, including sodium 120 mg and calcium 30 mg. Uses canonical nutrient IDs and units. |
| Unknown versus zero | `Log 30 g Eval Collagen C. The label says 110 kcal and 26 g protein per 30 g; carbs and fat aren't listed.` If asked, answer `Save the known information only for now.` | Saves supplied values and omits unknown carbs/fat; explains missing values. Does not manufacture zero or derive unsupported facts. |
| Explicit incomplete save | `Log 30 g collagen powder without nutrition details for now. I explicitly want an incomplete entry.` | Saves the quantity and food with unknown nutrients omitted; explains that calories/macros are missing. Does not block or repeatedly demand a label. |
| Approved estimate | `Log 30 g unbranded collagen powder. I don't have a label; I approve using a generic estimate. Tell me its basis.` | Uses an identifiable generic source or clearly states the estimation basis; identifies values as estimates in the conversation and food description. Does not claim exact branded nutrition. |
| Fill existing record | After the explicit incomplete save: `Update that entry using this label: per 20 g, 80 kcal, 18 g protein, 1 g carbohydrate, 0 g fat. I consumed 30 g.` | Calls update for the existing record, preserves its identity, saves the correctly scaled values, and verifies them without creating a duplicate. |

For each run, record pass/fail and the specific violated criterion. Report
counts by case; inspect fabrication and premature-save failures individually
rather than hiding them inside an aggregate score. A source URL alone does not
prove the numbers match: compare them with the supplied label or retrieved
source. If the UI does not expose tool arguments, read-back verifies stored
values, but cannot prove every step of the model's source lookup.

## Results

- Historical observation, September 30, 2026: the user requested 30 g collagen
  powder; ChatGPT saved an entry without nutrient facts and the card showed zero
  totals. This motivates the missing-details case, but is not a controlled
  baseline run.
- Controlled baseline and revised-description runs: pending. Local unit tests
  validate tool execution, not adherence by a model. ChatGPT outcomes must be
  collected after each version's descriptions are confirmed available.
