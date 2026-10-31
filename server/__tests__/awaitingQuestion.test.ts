import { describe, expect, it } from 'vitest';

import { questionText } from '../src/awaitingQuestion.js';

const ask = (...questions: unknown[]) => ({
  questions: questions.map((question) => ({ question })),
});
const TOKEN = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
const AWS_KEY = 'AKIA' + 'IOSFODNN7EXAMPLE';

describe('questionText', () => {
  it('reads the first question and counts the others', () => {
    expect(questionText(ask('Which database?'))).toBe('Which database?');
    expect(questionText(ask('Which database?', 'Which region?', 'Ship it?'))).toBe(
      'Which database? (+2)',
    );
  });

  // The ticket falls back to "Has a question" only when the field is absent, never "".
  it.each([
    ['no input', undefined],
    ['no questions key', {}],
    ['an empty list', { questions: [] }],
    ['a non-array list', { questions: 'Which?' }],
    ['a non-string question', ask(42)],
    ['a blank question', ask('  \n\t ')],
  ])('gives no text for %s', (_case, input) => {
    expect(questionText(input)).toBeUndefined();
  });

  it('redacts a token before it can be cut, flattens whitespace and drops bidi controls', () => {
    const text = questionText(ask(`Use ${TOKEN}\nor ${AWS_KEY}?‮ reversed​  text\u0007 here`));
    expect(text).toBeDefined();
    expect(text).not.toContain('ghp_');
    expect(text).not.toContain('AKIA');
    expect(text).not.toMatch(/[\n‮​\u0007]/);
    expect(text).not.toMatch(/ {2}/);
  });

  it('cuts a long question to 300 code points, counting the "(+N)" suffix and the ellipsis', () => {
    const long = questionText(ask('x'.repeat(700)))!;
    expect(Array.from(long)).toHaveLength(300);
    expect(long.endsWith('…')).toBe(true);
    const withMore = questionText(ask('x'.repeat(700), 'second'))!;
    expect(Array.from(withMore)).toHaveLength(300);
    expect(withMore.endsWith('… (+1)')).toBe(true);
    // Astral characters are one code point each, so a cut never splits a surrogate pair.
    const emoji = questionText(ask('\u{1F600}'.repeat(700)))!;
    expect(Array.from(emoji)).toHaveLength(300);
    expect(emoji).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
});
