import type sax from "sax";

/**
 * Parse Apple Health date format: "2024-03-01 10:30:00 -0500"
 * Convert to ISO 8601 so Date() can handle it.
 */
export function parseHealthDate(dateStr: string): Date {
  // "2024-03-01 10:30:00 -0500" -> "2024-03-01T10:30:00-05:00"
  const match = dateStr.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+([+-]\d{2})(\d{2})$/);
  if (!match) {
    return new Date(dateStr); // fallback
  }
  return new Date(`${match[1]}T${match[2]}${match[3]}:${match[4]}`);
}

/**
 * Extract string attributes from a SAX node.
 * When `strict=true` is used without `xmlns`, SAX always returns `Tag` with
 * `{ [key: string]: string }` attributes, but the TS union type includes
 * `QualifiedTag` too. This helper converts both shapes to `Record<string, string>`.
 */
export function getStringAttrs(node: sax.Tag | sax.QualifiedTag): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(node.attributes)) {
    result[key] = typeof val === "string" ? val : val.value;
  }
  return result;
}
