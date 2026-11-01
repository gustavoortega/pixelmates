import { describe, expect, it } from 'vitest';

import { questionText, trailingQuestion } from '../src/awaitingQuestion.js';

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

describe('trailingQuestion', () => {
  it.each([
    [
      'a question under a markdown list',
      'Listo.\n\n**Necesito de vos:**\n- ¿Lo hago con /auto-deploy y sale en la 1.0.5?',
      '¿Lo hago con /auto-deploy y sale en la 1.0.5?',
    ],
    ['the last sentence of a line', 'Merged. Ship it now?', 'Ship it now?'],
    ['a closer after the mark', '(want me to retry?)', 'want me to retry?'],
    ['a bolded question', '**Ship it now?**', 'Ship it now?'],
    ['a fullwidth mark', 'Ship it now？', 'Ship it now?'],
    ['several in the last paragraph', '- ¿A?\n- ¿B?\n- ¿C?', '¿C? (+2)'],
    ['a question after an earlier paragraph that asked', 'Ready?\n\nDone.\nShip it?', 'Ship it?'],
  ])('reads %s', (_case, text, expected) => {
    expect(trailingQuestion(text)).toEqual({ text: expected });
  });

  it.each([
    ['a mark inside code', 'Use `a?b` here.'],
    ['a question followed by an answer', 'Is it ready? Yes, merged.'],
    ['a lone mark', '?'],
    ['only blank lines', '\n  \n'],
    ['an earlier line asking, the last one stating', 'Ship it?\nMerged.'],
  ])('finds none for %s', (_case, text) => {
    expect(trailingQuestion(text)).toBeUndefined();
  });

  it('redacts a token and cuts a long question to 300 code points', () => {
    expect(trailingQuestion(`Deploy with ${TOKEN}?`)?.text).not.toContain('ghp_');
    const long = trailingQuestion('y'.repeat(2000) + '?')!.text!;
    expect(Array.from(long)).toHaveLength(300);
    expect(long.endsWith('…')).toBe(true);
  });

  it('keeps a question the redaction fails closed on, without its text', () => {
    expect(trailingQuestion('Where is the private key?')).toEqual({ text: undefined });
  });
});
