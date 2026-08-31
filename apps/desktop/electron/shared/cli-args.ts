function argvIncludesVerbose(argv: string[]): boolean {
  return argv.includes('-v') || argv.includes('--verbose');
}

/** True when `-v` / `--verbose` is passed or `BUDDY_TUNNEL_VERBOSE` is set. */
export function isVerboseEnabled(argv: string[] = process.argv): boolean {
  const env = process.env.BUDDY_TUNNEL_VERBOSE;
  if (env === '1' || env === 'true') {
    return true;
  }
  return argvIncludesVerbose(argv);
}
