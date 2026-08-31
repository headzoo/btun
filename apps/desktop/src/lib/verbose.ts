function isVerbose(): boolean {
  return window.appFlags?.verbose === true;
}

export function verboseLog(scope: string, message: string, detail?: unknown): void {
  if (!isVerbose()) {
    return;
  }
  const tag = `[buddy-tunnel:${scope}]`;
  const line =
    detail === undefined ? `${tag} ${message}` : `${tag} ${message} ${JSON.stringify(detail)}`;
  console.log(line);
}
