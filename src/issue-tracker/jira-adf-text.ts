// Jira ticket 04: Atlassian Document Format (the Card description) as plain text for the Builder's context. Structural and bounded: known
// nodes are rendered, unknown nodes keep only their text content, nothing else of the JSON is echoed.

type Node = { type?: unknown; text?: unknown; attrs?: Record<string, unknown>; content?: unknown };
const maxDepth = 64;
const blocks = new Set([
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'codeBlock',
  'blockquote',
  'rule',
  'panel',
  'table',
  'tableRow',
  'tableHeader',
  'tableCell',
  'mediaSingle',
  'mediaGroup',
  'expand',
  'nestedExpand',
  'taskList',
  'taskItem',
  'decisionList',
  'decisionItem',
  'blockCard',
]);

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && !Array.isArray(value);
const children = (node: Node): Node[] => (Array.isArray(node.content) ? node.content.filter(isNode) : []);
const attr = (node: Node, name: string) =>
  typeof node.attrs?.[name] === 'string' ? (node.attrs[name] as string) : typeof node.attrs?.[name] === 'number' ? String(node.attrs[name]) : null;

/** What a node's renderer may use: the node, its children joined (`inner`), and one child rendered one level deeper. */
type Rendering = { node: Node; inner: (separator?: string) => string; child: (item: Node) => string };
const fromInner = ({ inner }: Rendering) => inner();
/** Known nodes by type; any other node keeps only its text content (`fromInner`). */
const renderers = new Map<unknown, (rendering: Rendering) => string>([
  ['text', ({ node }) => (typeof node.text === 'string' ? node.text : '')],
  ['hardBreak', () => '\n'],
  ['mention', ({ node }) => attr(node, 'text') ?? `@${attr(node, 'id') ?? ''}`],
  ['emoji', ({ node }) => attr(node, 'text') ?? attr(node, 'shortName') ?? ''],
  ['inlineCard', ({ node }) => attr(node, 'url') ?? ''],
  ['blockCard', ({ node }) => attr(node, 'url') ?? ''],
  ['status', ({ node }) => attr(node, 'text') ?? ''],
  ['date', ({ node }) => attr(node, 'timestamp') ?? ''],
  ['rule', () => '---'],
  ['heading', ({ node, inner }) => `${'#'.repeat(Math.min(Math.max(Number(attr(node, 'level') ?? 1), 1), 6))} ${inner('')}`],
  ['paragraph', ({ inner }) => inner('')],
  [
    'bulletList',
    ({ node, child }) =>
      children(node)
        .map(item => `- ${child(item)}`)
        .join('\n'),
  ],
  [
    'orderedList',
    ({ node, child }) => {
      const start = Number(attr(node, 'order') ?? 1);
      return children(node)
        .map((item, index) => `${(Number.isSafeInteger(start) ? start : 1) + index}. ${child(item)}`)
        .join('\n');
    },
  ],
  ['listItem', ({ inner }) => inner('\n')],
  ['codeBlock', ({ node, inner }) => `\`\`\`${attr(node, 'language') ?? ''}\n${inner('')}\n\`\`\``],
  [
    'blockquote',
    ({ inner }) =>
      inner()
        .split('\n')
        .map(line => `> ${line}`)
        .join('\n'),
  ],
]);

/**
 * Plain text of an ADF document, at most `maxChars` characters (`truncated` says the bound or the nesting depth cut something: never a
 * silent truncation). `null` when the value is not an ADF document (absent description included).
 */
export function adfPlainText(value: unknown, maxChars: number): { text: string; truncated: boolean } | null {
  if (!isNode(value) || value.type !== 'doc') return null;
  let truncated = false;
  const render = (node: Node, depth: number): string => {
    if (depth > maxDepth) {
      truncated = true;
      return '';
    }
    const child = (item: Node) => render(item, depth + 1);
    const inner = (separator?: string) => {
      const items = children(node);
      const joiner = separator ?? (items.some(item => typeof item.type === 'string' && blocks.has(item.type)) ? '\n\n' : '');
      return items.map(child).join(joiner);
    };
    return (renderers.get(node.type) ?? fromInner)({ node, inner, child });
  };
  const text = render(value, 0);
  if (text.length > maxChars) return { text: text.slice(0, maxChars), truncated: true };
  return { text, truncated };
}
