import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adfPlainText } from '../../src/issue-tracker/index.js';

// Jira ticket 04 (agent context): the controller hands the Card's description to the Builder as plain text; the agent never gets a Jira
// client or token. Atlassian Document Format is converted structurally, bounded, never by echoing unknown JSON.
const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content });
const p = (...content: unknown[]) => ({ type: 'paragraph', content });
const text = (value: string, marks?: unknown[]) => ({ type: 'text', text: value, ...(marks ? { marks } : {}) });

test('paragraphs, headings, lists, code, mentions and links become readable plain text', () => {
  const adf = doc(
    { type: 'heading', attrs: { level: 2 }, content: [text('Contexto')] },
    p(text('Cobrar em '), text('reais', [{ type: 'strong' }]), { type: 'hardBreak' }, text('sem centavos')),
    { type: 'bulletList', content: [{ type: 'listItem', content: [p(text('um'))] }, { type: 'listItem', content: [p(text('dois'))] }] },
    { type: 'orderedList', content: [{ type: 'listItem', content: [p(text('primeiro'))] }] },
    { type: 'codeBlock', attrs: { language: 'ts' }, content: [text('const x = 1;')] },
    p({ type: 'mention', attrs: { id: 'abc', text: '@Ana' } }, text(' ver '), { type: 'inlineCard', attrs: { url: 'https://example.org/doc' } }, text(' '),
      { type: 'emoji', attrs: { shortName: ':smile:', text: '😄' } }),
  );
  assert.deepEqual(adfPlainText(adf, 10000), { text: '## Contexto\n\nCobrar em reais\nsem centavos\n\n- um\n- dois\n\n1. primeiro\n\n```ts\nconst x = 1;\n```\n\n@Ana ver https://example.org/doc 😄', truncated: false });
});

test('unknown nodes keep their text content; a non-document is null; the bound is explicit, never silent', () => {
  assert.deepEqual(adfPlainText(doc({ type: 'panel', content: [p(text('dentro'))] }), 100), { text: 'dentro', truncated: false });
  assert.equal(adfPlainText(null, 100), null);
  assert.equal(adfPlainText('texto', 100), null);
  assert.equal(adfPlainText({ type: 'paragraph' }, 100), null);
  assert.deepEqual(adfPlainText(doc(p(text('abcdefghij'))), 4), { text: 'abcd', truncated: true });
  // Depth is bounded too (a hostile nesting is cut, not recursed into without end).
  let deep: unknown = text('fundo');
  for (let i = 0; i < 200; i++) deep = { type: 'panel', content: [deep] };
  assert.deepEqual(adfPlainText(doc(deep), 100), { text: '', truncated: true });
});
