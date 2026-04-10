const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//;
const PREVIEW_PR_PATTERN = /^\/preview\/pr-(\d+)$/;

/**
 * Normalize an incoming deep-link path. Custom-scheme deep links arrive as
 * full URLs (e.g. `dofek://preview/pr-831`), while in-app navigations arrive
 * as bare paths (`/preview`). Strip the scheme so route matching works either way.
 */
function normalizePath(path: string): string {
  if (!path.includes("://") || path.startsWith("file://")) {
    return path;
  }
  const stripped = path.replace(SCHEME_PATTERN, "");
  return stripped.startsWith("/") ? stripped : `/${stripped}`;
}

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  if (path.startsWith("file://")) {
    return `/providers?sharedFile=${encodeURIComponent(path)}`;
  }

  const normalized = normalizePath(path);

  const previewMatch = normalized.match(PREVIEW_PR_PATTERN);
  if (previewMatch) {
    return `/preview?pr=${previewMatch[1]}`;
  }

  return normalized;
}
