import { describe, it, expect } from '@jest/globals';
import { findVerbatimMatches, findVerbatimRanges } from '../src/resolver.js';

describe('findVerbatimMatches', () => {
  const file = [
    'import { foo } from "bar";',
    '',
    'function baz() {',
    '  const token = localStorage.getItem("jwt");',
    '  return token;',
    '}',
  ];

  it('finds a unique substring match (1-indexed)', () => {
    expect(findVerbatimMatches(file, 'localStorage.getItem("jwt")')).toEqual([4]);
  });

  it('returns multiple line numbers for ambiguous quotes', () => {
    const ambiguous = ['return token;', 'return token;', 'return user;'];
    expect(findVerbatimMatches(ambiguous, 'return token;')).toEqual([1, 2]);
  });

  it('returns empty array when quote is absent', () => {
    expect(findVerbatimMatches(file, 'this string does not appear anywhere')).toEqual([]);
  });

  it('trims surrounding whitespace on the needle', () => {
    expect(findVerbatimMatches(file, '   localStorage.getItem("jwt")   ')).toEqual([4]);
  });

  it('matches multi-line quotes via sliding window over consecutive file lines', () => {
    const multi = '  const token = localStorage.getItem("jwt");\n  return token;';
    expect(findVerbatimMatches(file, multi)).toEqual([4]);
  });

  it('matches indented multi-line quotes after dedent retry', () => {
    // Critics often quote without preserving original indentation.
    const dedentedQuote = 'const token = localStorage.getItem("jwt");\nreturn token;';
    expect(findVerbatimMatches(file, dedentedQuote)).toEqual([4]);
  });

  it('does not return false matches for unrelated multi-line quotes', () => {
    const otherQuote = 'function bar() {\n  not in file';
    expect(findVerbatimMatches(file, otherQuote)).toEqual([]);
  });

  it('returns full ranges for multi-line quotes so resolver can anchor to changed lines inside', () => {
    // Regression for round-13 finding: pinning to the window start
    // silently misroutes findings when the actual changed line is in
    // the middle or end of the quoted block.
    const fileWithBlock = [
      'export function login(user) {',  // 1
      '  const token = localStorage.getItem("jwt");',  // 2 (changed)
      '  return token;',  // 3
      '}',  // 4
    ];
    const multiLineQuote = 'export function login(user) {\n  const token = localStorage.getItem("jwt");\n  return token;\n}';
    const ranges = findVerbatimRanges(fileWithBlock, multiLineQuote);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toEqual({ start: 1, end: 4 });
  });

  it('exposes a range for single-line quotes too (start === end)', () => {
    const file = ['line 1', 'target', 'line 3'];
    const ranges = findVerbatimRanges(file, 'target');
    expect(ranges).toEqual([{ start: 2, end: 2 }]);
  });

  it('matches quotes against CRLF-terminated source files (split-on-/\\r?\\n/)', () => {
    // Simulates what getFileLines produces when split on /\r?\n/. The
    // earlier split('\n') would have left \r at line ends and silently
    // failed multi-line matches against any Windows-authored file.
    const crlfFile = [
      'function login(user) {',
      '  const token = localStorage.getItem("jwt");',
      '  return token;',
      '}',
    ];
    const multi = '  const token = localStorage.getItem("jwt");\n  return token;';
    expect(findVerbatimMatches(crlfFile, multi)).toEqual([2]);
  });

  it('rejects empty / whitespace-only quotes', () => {
    expect(findVerbatimMatches(file, '')).toEqual([]);
    expect(findVerbatimMatches(file, '   ')).toEqual([]);
  });
});
