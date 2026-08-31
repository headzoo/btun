import { describe, expect, it } from 'vitest';

import { generateFirebasePushId } from '../../packages/firebase/src/rtdb-push-id';

describe('generateFirebasePushId', () => {
  it('matches RTDB id rules', () => {
    const id = generateFirebasePushId(1_700_000_000_000);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(id.length).toBe(20);
  });

  it('generates distinct ids', () => {
    const a = generateFirebasePushId();
    const b = generateFirebasePushId();
    expect(a).not.toBe(b);
  });
});
