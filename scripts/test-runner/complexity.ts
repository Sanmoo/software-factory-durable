// The complexity part of the Static metrics quality gate: cyclomatic complexity (ESLint's `complexity` rule) is at most 10 per
// function of src/. Every function above the limit at adoption is a tolerated finding of scripts/test-runner/static-metrics-tolerated.json,
// identified by file and function, never by line: a function is named by the chain of named declarations that contain it
// (`Class.method > read`), and an anonymous one by its kind and ordinal among the anonymous functions of that container
// (`handler > arrow#2`), so an edit elsewhere in the file never moves an identity. Pure: the caller measures and reads the files.
import ts from 'typescript';

export const limit = 10;

export interface Measured {
  file: string;
  line: number;
  column: number;
  complexity: number;
}
export interface Finding {
  file: string;
  function: string;
  complexity: number;
}
export interface Entry extends Finding {
  decision: string;
}

type FunctionNode = ts.FunctionLikeDeclaration;

function isFunction(node: ts.Node): node is FunctionNode {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function nameText(name: ts.Node | undefined, source: ts.SourceFile): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return name.getText(source).replace(/\s+/g, ' ');
}

/** The name a declaration gives its own scope: a function, class, method, accessor, or the variable or property it is bound to. */
function ownName(node: ts.Node, source: ts.SourceFile): string | undefined {
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (ts.isGetAccessorDeclaration(node)) return `get ${nameText(node.name, source)}`;
  if (ts.isSetAccessorDeclaration(node)) return `set ${nameText(node.name, source)}`;
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node))
    return nameText(node.name, source);
  if (ts.isFunctionExpression(node) && node.name) return node.name.text;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isClassExpression(node)) {
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && parent.initializer === node) return nameText(parent.name, source);
    if (ts.isPropertyAssignment(parent) && parent.initializer === node) return nameText(parent.name, source);
    if (ts.isPropertyDeclaration(parent) && parent.initializer === node) return nameText(parent.name, source);
  }
  return undefined;
}

const kind = (node: FunctionNode) => (ts.isArrowFunction(node) ? 'arrow' : 'function');

/** Every function of a file with its identity and the source range ESLint's report position falls into. */
export function functionsOf(file: string, text: string): { identity: string; start: number; end: number }[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: { identity: string; start: number; end: number }[] = [];
  const visit = (node: ts.Node, path: string[], anonymous: Map<string, number>): void => {
    let childPath = path,
      childAnonymous = anonymous;
    const named = isFunction(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node) ? ownName(node, source) : undefined;
    if (isFunction(node)) {
      let segment = named;
      if (segment === undefined) {
        const key = kind(node);
        const ordinal = (anonymous.get(key) ?? 0) + 1;
        anonymous.set(key, ordinal);
        segment = `${key}#${ordinal}`;
      }
      childPath = [...path, segment];
      childAnonymous = new Map();
      // ESLint reports a function bound to a property or variable at the binding's name, before the function node itself.
      const binding =
        ts.isVariableDeclaration(node.parent) || ts.isPropertyAssignment(node.parent) || ts.isPropertyDeclaration(node.parent) ? node.parent : node;
      found.push({ identity: childPath.join(' > '), start: Math.min(binding.getStart(source), node.getStart(source)), end: node.getEnd() });
    } else if (named !== undefined) {
      childPath = [...path, named];
      childAnonymous = new Map();
    }
    ts.forEachChild(node, child => visit(child, childPath, childAnonymous));
  };
  visit(source, [], new Map());
  // Two functions with one identity (an overload body, two object literals with the same keys) are told apart by order.
  const seen = new Map<string, number>();
  for (const item of found) {
    const count = (seen.get(item.identity) ?? 0) + 1;
    seen.set(item.identity, count);
    if (count > 1) item.identity = `${item.identity} (${count})`;
  }
  return found;
}

/** Each measured function above the limit at its identity: the innermost function whose range holds the reported position. */
export function identify(measured: readonly Measured[], read: (file: string) => string): Finding[] {
  const byFile = new Map<string, Measured[]>();
  for (const item of measured) byFile.set(item.file, [...(byFile.get(item.file) ?? []), item]);
  const findings: Finding[] = [];
  for (const [file, items] of byFile) {
    const text = read(file);
    const functions = functionsOf(file, text);
    const offsets = [0];
    for (let index = 0; index < text.length; index++) if (text[index] === '\n') offsets.push(index + 1);
    for (const item of items) {
      const position = offsets[item.line - 1]! + item.column - 1;
      const holder = functions.filter(f => f.start <= position && position < f.end).sort((a, b) => a.end - a.start - (b.end - b.start))[0];
      findings.push({ file, function: holder?.identity ?? `${item.line}:${item.column}`, complexity: item.complexity });
    }
  }
  return findings.sort((a, b) => `${a.file} ${a.function}`.localeCompare(`${b.file} ${b.function}`));
}

/** ESLint's `complexity` message carries the measured value. */
export function measuredValue(message: string): number | undefined {
  const value = /complexity of (\d+)/.exec(message)?.[1];
  return value === undefined ? undefined : Number(value);
}

export function parseTolerance(value: unknown): Entry[] {
  const entries = (value as { complexity?: unknown }).complexity;
  if (!Array.isArray(entries)) throw new Error('STATIC_METRICS_POLICY_INVALID: complexity must be a list');
  return entries.map((raw, index) => {
    const entry = raw as Record<string, unknown>;
    const ok =
      typeof entry.file === 'string' &&
      typeof entry.function === 'string' &&
      Number.isInteger(entry.complexity) &&
      (entry.complexity as number) > limit &&
      typeof entry.decision === 'string' &&
      entry.decision.trim().length > 0;
    if (!ok) throw new Error(`STATIC_METRICS_POLICY_INVALID: complexity entry ${index} needs file, function, a complexity above ${limit} and the decision`);
    return entry as unknown as Entry;
  });
}

/**
 * One entry tolerates one function at its recorded value. A function above the limit with no entry fails; one above its entry
 * grew and fails; one below its entry (or no longer above the limit) leaves its entry to be lowered or removed in the same
 * change, and fails until it is. Entries of files outside `analyzed` are not matched.
 */
export function matchComplexity(
  findings: readonly Finding[],
  tolerated: readonly Entry[],
  analyzed: (file: string) => boolean,
): { rule: string; location: string }[] {
  const failures: { rule: string; location: string }[] = [];
  const key = (item: Finding) => `${item.file} ${item.function}`;
  const entries = new Map<string, Entry>();
  for (const entry of tolerated) {
    if (entries.has(key(entry))) failures.push({ rule: 'complexity:duplicate-entry', location: `${entry.file} ${entry.function}` });
    entries.set(key(entry), entry);
  }
  const seen = new Set<string>();
  for (const finding of findings) {
    seen.add(key(finding));
    const entry = entries.get(key(finding));
    const location = `${finding.file} ${finding.function} (${finding.complexity})`;
    if (!entry) failures.push({ rule: 'complexity', location });
    else if (finding.complexity > entry.complexity) failures.push({ rule: 'complexity:grew', location: `${location}, tolerated at ${entry.complexity}` });
    else if (finding.complexity < entry.complexity)
      failures.push({ rule: 'complexity:tolerance-loose', location: `${location}, tolerated at ${entry.complexity}: lower the entry` });
  }
  for (const [name, entry] of entries)
    if (!seen.has(name) && analyzed(entry.file))
      failures.push({ rule: 'complexity:stale-entry', location: `${entry.file} ${entry.function} (tolerated at ${entry.complexity}): remove the entry` });
  return failures.sort((a, b) => a.location.localeCompare(b.location));
}
