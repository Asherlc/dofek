const XML_ESCAPE_RE = /[&<>"']/g;
const XML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

export function escapeXml(value: string): string {
  return value.replace(XML_ESCAPE_RE, (char) => XML_ESCAPE[char] ?? char);
}
