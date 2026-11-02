import { describe, expect, it } from "vitest";
import { cataloguePlainText } from "./area-context.ts";

describe("cataloguePlainText", () => {
  it("decodes source HTML into display text without executable markup", () => {
    expect(
      cataloguePlainText(
        "<p>Sandstone &amp; shade.</p><script>alert('ignored')</script><style>.hidden{}</style>",
      ),
    ).toBe("Sandstone & shade.");
  });
  it("preserves ordinary text and treats empty content as unknown", () => {
    expect(cataloguePlainText("A <5 min approach.  Keep the gate clear.")).toBe(
      "A <5 min approach. Keep the gate clear.",
    );
    expect(cataloguePlainText(" <p> </p> ")).toBeNull();
    expect(cataloguePlainText(null)).toBeNull();
    expect(cataloguePlainText(undefined)).toBeNull();
  });
  it("keeps words separated across source paragraphs and list items", () => {
    expect(
      cataloguePlainText(
        "<p>Use the trail.</p><p>Keep gates clear.</p><ul><li>No fires.</li><li>No camping.</li></ul>",
      ),
    ).toBe("Use the trail. Keep gates clear. No fires. No camping.");
  });
});
