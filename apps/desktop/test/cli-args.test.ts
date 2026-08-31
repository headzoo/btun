import { describe, expect, it } from 'vitest';

import { isVerboseEnabled } from '../electron/shared/cli-args';

describe('isVerboseEnabled', () => {
  it('is false by default', () => {
    expect(isVerboseEnabled(['electron', 'app'])).toBe(false);
  });

  it('enables with -v', () => {
    expect(isVerboseEnabled(['electron', 'app', '-v'])).toBe(true);
  });

  it('enables with --verbose', () => {
    expect(isVerboseEnabled(['electron', 'app', '--verbose'])).toBe(true);
  });
});
