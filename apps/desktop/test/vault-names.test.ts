import { describe, expect, it } from 'vitest';
import {
  isSafeLocalName,
  isVaultMetadataName,
  isVaultTempName,
  sanitizePreferredName,
  splitStemExt,
  uniquifyLocalName,
  validateLocalName,
  vaultTempName,
} from '@yard-1/vault';

describe('validateLocalName', () => {
  it.each([
    ['Report.pdf', true],
    ['Makefile', true],
    ['.gitignore', true],
    ['archive.tar.gz', true],
    ['café.txt', true],
    ['日本語.md', true],
  ])('accepts safe name %s', (name, expected) => {
    expect(isSafeLocalName(name)).toBe(expected);
    expect(validateLocalName(name).ok).toBe(expected);
  });

  it.each([
    ['foo/bar', 'separator-or-illegal'],
    ['foo\\bar', 'separator-or-illegal'],
    ['CON', 'windows-reserved'],
    ['com1.txt', 'windows-reserved'],
    ['LPT9', 'windows-reserved'],
    ['Report.pdf ', 'trailing-dot-or-space'],
    ['Report.pdf.', 'trailing-dot-or-space'],
    ['.', 'dot-or-dotdot'],
    ['..', 'dot-or-dotdot'],
    ['.buddy-tunnel.json', 'index-or-temp'],
    ['.buddy-tunnel.token.tmp', 'index-or-temp'],
    ['', 'empty'],
  ])('rejects %s with issue %s', (name, issue) => {
    const result = validateLocalName(name);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issue).toBe(issue);
    }
  });
});

describe('splitStemExt', () => {
  it('preserves leading-dot and multi-dot behavior', () => {
    expect(splitStemExt('Report.pdf')).toEqual({ stem: 'Report', ext: '.pdf' });
    expect(splitStemExt('Makefile')).toEqual({ stem: 'Makefile', ext: '' });
    expect(splitStemExt('.gitignore')).toEqual({ stem: '.gitignore', ext: '' });
    expect(splitStemExt('archive.tar.gz')).toEqual({ stem: 'archive.tar', ext: '.gz' });
    expect(splitStemExt('.foo.bar')).toEqual({ stem: '.foo', ext: '.bar' });
  });
});

describe('uniquifyLocalName', () => {
  it('returns the preferred name when it is free', () => {
    expect(uniquifyLocalName('Report.pdf', ['Notes.txt'])).toBe('Report.pdf');
  });

  it.each([
    { preferred: 'Report.pdf', occupied: ['Report.pdf'], expected: 'Report.2.pdf' },
    {
      preferred: 'Report.pdf',
      occupied: ['Report.pdf', 'Report.2.pdf'],
      expected: 'Report.3.pdf',
    },
    { preferred: 'Makefile', occupied: ['Makefile'], expected: 'Makefile.2' },
    { preferred: '.gitignore', occupied: ['.gitignore'], expected: '.gitignore.2' },
    {
      preferred: 'archive.tar.gz',
      occupied: ['archive.tar.gz'],
      expected: 'archive.tar.2.gz',
    },
    { preferred: 'note.txt', occupied: ['note.txt', 'note.2.txt'], expected: 'note.3.txt' },
  ])('uniquifies $preferred against $occupied → $expected', ({ preferred, occupied, expected }) => {
    expect(uniquifyLocalName(preferred, occupied)).toBe(expected);
  });

  it.each([
    {
      name: 'report.pdf',
      occupied: ['Report.pdf'],
      caseSensitive: false,
      expected: 'report.2.pdf',
    },
    {
      name: 'report.pdf',
      occupied: ['Report.pdf'],
      caseSensitive: true,
      expected: 'report.pdf',
    },
  ])(
    'case collision (caseSensitive=$caseSensitive)',
    ({ name, occupied, caseSensitive, expected }) => {
      expect(uniquifyLocalName(name, occupied, { caseSensitive })).toBe(expected);
    },
  );

  it('sanitizes unsafe preferred names before uniquifying', () => {
    expect(uniquifyLocalName('foo/bar.txt', [])).toBe('foo_bar.txt');
    expect(isSafeLocalName(uniquifyLocalName('CON.txt', ['CON.txt']))).toBe(true);
  });
});

describe('vault metadata names', () => {
  it('classifies index and temp artifacts', () => {
    expect(isVaultMetadataName('.buddy-tunnel.json')).toBe(true);
    expect(isVaultTempName(vaultTempName('abc-123'))).toBe(true);
    expect(isVaultMetadataName('Report.pdf')).toBe(false);
  });

  it('turns reserved names into safe fallbacks', () => {
    expect(isSafeLocalName(sanitizePreferredName('NUL'))).toBe(true);
    expect(isSafeLocalName(sanitizePreferredName('..'))).toBe(true);
  });
});
