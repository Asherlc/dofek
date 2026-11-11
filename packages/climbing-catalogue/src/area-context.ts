import { load } from "cheerio";

/** Source descriptions are display text, never executable provider markup. */
export function cataloguePlainText(value: string | null | undefined): string | null {
  if (!value) return null;
  const $ = load(value);
  $("script, style").remove();
  $("p, div, li, br, section, blockquote, h1, h2, h3, h4, h5, h6").append(" ");
  return $.root().text().replace(/\s+/gu, " ").trim() || null;
}
