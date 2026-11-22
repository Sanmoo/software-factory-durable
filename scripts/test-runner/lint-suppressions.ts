// Lint suppressions as tolerated findings: every ESLint directive in the code that turns a rule off is a finding the Lint quality
// gate hides, so it must match one entry of scripts/test-runner/lint-tolerated.json (approved in ADOPTION-PLAN.md). A directive
// with no entry fails, an entry with no directive is stale and fails, and two directives never share one entry. Pure: the caller
// reads the files. Only real comments count (from the TypeScript parser), never text inside strings or templates.
import ts from 'typescript';

export interface Directive {
  file: string;
  line: number;
  kind: string;
  rules: string[];
  target: string;
}
export interface Entry {
  file: string;
  rule: string;
  target: string;
  reason: string;
  decision: string;
}

/** The comment ranges of a source file, each once: leading and trailing trivia of every node, as the parser sees them. */
function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /\.[cm]?jsx?$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
}

function comments(source: ts.SourceFile, text: string): { pos: number; text: string }[] {
  const seen = new Map<number, string>();
  const collect = (ranges: readonly ts.CommentRange[] | undefined) => {
    for (const range of ranges ?? []) seen.set(range.pos, text.slice(range.pos, range.end));
  };
  const visit = (node: ts.Node): void => {
    collect(ts.getLeadingCommentRanges(text, node.getFullStart()));
    collect(ts.getTrailingCommentRanges(text, node.getEnd()));
    ts.forEachChild(node, visit);
  };
  visit(source);
  collect(ts.getLeadingCommentRanges(text, source.endOfFileToken.getFullStart()));
  return [...seen].sort(([a], [b]) => a - b).map(([pos, body]) => ({ pos, text: body }));
}

/** Code text with what a formatter decides (line breaks, indentation, trailing commas) normalized away. */
export function codeShape(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/,\s*([)\]}])/g, '$1')
    .replace(/([([{]) /g, '$1')
    .replace(/ ([)\]}])/g, '$1')
    .trim();
}

/** The whole statement that starts on 0-based `line` (or the line's text when none starts there), in its code shape. */
function statementAt(source: ts.SourceFile, line: number, fallback: string): string {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isStatement(node) && !ts.isBlock(node) && source.getLineAndCharacterOfPosition(node.getStart(source)).line === line) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return codeShape(found ? found.getText(source) : fallback);
}

/** `eslint-disable-next-line a, b -- reason`, `-line`, block `eslint-disable` (with or without rules), `eslint rule: off` config. */
const directive = /^(?:\/\/|\/\*)\s*eslint(-disable(?:-next-line|-line)?|-enable)?(?=[\s*]|$)([\s\S]*)/;

/**
 * The directives of one file. `target` identifies what a directive suppresses: the whole statement starting on the line it applies
 * to (the next line for `-next-line`, its own line for `-line`) in its code shape, so a reformat never moves the identity; a block
 * or file directive targets the whole file ('*').
 */
export function directivesOf(file: string, text: string): Directive[] {
  const lines = text.split('\n');
  const source = parse(file, text);
  const found: Directive[] = [];
  for (const comment of comments(source, text)) {
    const match = directive.exec(comment.text);
    if (!match) continue;
    const kind = match[1] ? `eslint${match[1]}` : 'eslint';
    // A rule-configuring `eslint` comment exists only as a block comment; a line comment that starts with the word is prose.
    if (kind === 'eslint-enable' || (kind === 'eslint' && comment.text.startsWith('//'))) continue;
    const index = text.slice(0, comment.pos).split('\n').length - 1;
    const body = match[2]!
      .replace(/\*\/\s*$/, '')
      .split(' -- ')[0]!
      .trim();
    const rules = body
      .split(',')
      .map(item => (kind === 'eslint' ? item.split(':')[0]! : item).trim())
      .filter(Boolean);
    const target =
      kind === 'eslint-disable-next-line'
        ? statementAt(source, index + 1, lines[index + 1] ?? '')
        : kind === 'eslint-disable-line'
          ? statementAt(source, index, lines[index]!.slice(0, comment.pos - text.lastIndexOf('\n', comment.pos - 1) - 1))
          : '*';
    found.push({ file, line: index + 1, kind, rules: rules.length ? rules : ['*'], target });
  }
  return found;
}

export function parseTolerance(value: unknown): Entry[] {
  const record = value as { schemaVersion?: unknown; entries?: unknown };
  if (record?.schemaVersion !== 1 || !Array.isArray(record.entries)) throw new Error('LINT_TOLERANCE_INVALID: schemaVersion 1 and an entries list');
  for (const entry of record.entries as Record<string, unknown>[]) {
    for (const key of ['file', 'rule', 'target', 'reason', 'decision']) {
      if (typeof entry[key] !== 'string' || !entry[key]) throw new Error(`LINT_TOLERANCE_INVALID: every entry needs a non-empty ${key}`);
    }
  }
  return record.entries as Entry[];
}

/** One entry per suppressed rule of one directive, and one directive rule per entry. */
export function matchSuppressions(directives: readonly Directive[], entries: readonly Entry[]): { rule: string; location: string }[] {
  const unused = new Set(entries.map((_, index) => index));
  const findings: { rule: string; location: string }[] = [];
  for (const item of directives) {
    for (const rule of item.rules) {
      const index = [...unused].find(at => entries[at]!.file === item.file && entries[at]!.rule === rule && entries[at]!.target === item.target);
      if (index === undefined) findings.push({ rule: 'suppression-not-tolerated', location: `${item.file}:${item.line} ${item.kind} ${rule}` });
      else unused.delete(index);
    }
  }
  for (const index of [...unused].sort((a, b) => a - b)) {
    const entry = entries[index]!;
    findings.push({ rule: 'suppression-stale', location: `${entry.file} ${entry.rule} (${entry.target})` });
  }
  return findings;
}
