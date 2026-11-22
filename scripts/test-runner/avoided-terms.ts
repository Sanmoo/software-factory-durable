// The Avoided terms quality gate: no identifier in source code contains a term GLOSSARY.md lists under _Avoid_. The list is
// read from GLOSSARY.md itself, so it exists in one place. Identifiers come from the TypeScript parser (comments and
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
  // A full parse, not the bare scanner: only the parser knows where a template literal or a regular expression ends.
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /\.[cm]?jsx?$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const found: { rule: string; location: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      const identifier = node.text;
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      for (const term of terms) if (words(identifier).includes(term)) found.push({ rule: `avoided:${term}`, location: `${file}:${line} ${identifier}` });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
