// The Avoided terms quality gate: no identifier in source code contains a term GLOSSARY.md lists under _Avoid_. The list is
// read from GLOSSARY.md itself, so it exists in one place. Identifiers come from the TypeScript scanner (comments and
// string literals are not identifiers) and are split on camelCase, snake_case and kebab-case boundaries; matching is
// case-insensitive on whole words.
import ts from 'typescript';

export function avoidedTerms(glossary: string): string[] {
  return [
    ...new Set(
      glossary
        .split('\n')
        .filter(line => line.startsWith('_Avoid_:'))
        .flatMap(line => line.slice('_Avoid_:'.length).split(','))
        .map(term => term.trim().toLowerCase())
        .filter(Boolean),
    ),
  ].sort();
}

export const words = (identifier: string) =>
  identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_\-$#]+/)
    .filter(Boolean)
    .map(word => word.toLowerCase());

export function findAvoided(file: string, text: string, terms: readonly string[]): { rule: string; location: string }[] {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const found: { rule: string; location: string }[] = [];
  const lineOf = (position: number) => text.slice(0, position).split('\n').length;
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind !== ts.SyntaxKind.Identifier && kind !== ts.SyntaxKind.PrivateIdentifier) continue;
    const identifier = scanner.getTokenText();
    for (const term of terms)
      if (words(identifier).includes(term)) found.push({ rule: `avoided:${term}`, location: `${file}:${lineOf(scanner.getTokenStart())} ${identifier}` });
  }
  return found;
}
