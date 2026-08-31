import { isVerboseEnabled } from './cli-args';

export function verboseLog(scope: string, message: string, detail?: unknown): void {
  if (!isVerboseEnabled()) {
    return;
  }
  const tag = `[buddy-tunnel:${scope}]`;
  const line =
    detail === undefined ? `${tag} ${message}` : `${tag} ${message} ${JSON.stringify(detail)}`;
  console.log(line);
}
