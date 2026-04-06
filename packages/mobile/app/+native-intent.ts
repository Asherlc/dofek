const PREVIEW_PR_PATTERN = /^\/preview\/pr-(\d+)$/;

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  if (path.startsWith("file://")) {
    return `/providers?sharedFile=${encodeURIComponent(path)}`;
  }

  const previewMatch = path.match(PREVIEW_PR_PATTERN);
  if (previewMatch) {
    return `/preview?pr=${previewMatch[1]}`;
  }

  return path;
}
