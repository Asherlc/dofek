export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  if (path.startsWith("file://")) {
    return `/providers?sharedFile=${encodeURIComponent(path)}`;
  }

  return path;
}
