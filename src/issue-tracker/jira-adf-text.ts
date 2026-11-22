// Jira ticket 04: Atlassian Document Format (the Card description) as plain text for the Builder's context. Structural and bounded: known
// nodes are rendered, unknown nodes keep only their text content, nothing else of the JSON is echoed.

type Node = { type?: unknown; text?: unknown; attrs?: Record<string, unknown>; content?: unknown };
const maxDepth = 64;
const blocks = new Set(['paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'codeBlock', 'blockquote', 'rule', 'panel', 'table', 'tableRow',
  'tableHeader', 'tableCell', 'mediaSingle', 'mediaGroup', 'expand', 'nestedExpand', 'taskList', 'taskItem', 'decisionList', 'decisionItem', 'blockCard']);

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && !Array.isArray(value);
const children = (node: Node): Node[] => Array.isArray(node.content) ? node.content.filter(isNode) : [];
const attr = (node: Node, name: string) => typeof node.attrs?.[name] === 'string' ? node.attrs[name] as string : typeof node.attrs?.[name] === 'number' ? String(node.attrs[name]) : null;

/**
 * Plain text of an ADF document, at most `maxChars` characters (`truncated` says the bound or the nesting depth cut something: never a
 * silent truncation). `null` when the value is not an ADF document (absent description included).
 */
export function adfPlainText(value: unknown, maxChars: number): { text: string; truncated: boolean } | null {
  if (!isNode(value) || value.type !== 'doc') return null;
  let truncated = false;
  const render = (node: Node, depth: number): string => {
    if (depth > maxDepth) { truncated = true; return ''; }
    const inner = (separator?: string) => {
      const items = children(node);
      const joiner = separator ?? (items.some(item => typeof item.type === 'string' && blocks.has(item.type)) ? '\n\n' : '');
      return items.map(item => render(item, depth + 1)).join(joiner);
    };
    switch (node.type) {
      case 'text': return typeof node.text === 'string' ? node.text : '';
      case 'hardBreak': return '\n';
      case 'mention': return attr(node, 'text') ?? `@${attr(node, 'id') ?? ''}`;
      case 'emoji': return attr(node, 'text') ?? attr(node, 'shortName') ?? '';
      case 'inlineCard': case 'blockCard': return attr(node, 'url') ?? '';
      case 'status': return attr(node, 'text') ?? '';
      case 'date': return attr(node, 'timestamp') ?? '';
      case 'rule': return '---';
      case 'heading': return `${'#'.repeat(Math.min(Math.max(Number(attr(node, 'level') ?? 1), 1), 6))} ${inner('')}`;
      case 'paragraph': return inner('');
      case 'bulletList': return children(node).map(item => `- ${render(item, depth + 1)}`).join('\n');
      case 'orderedList': {
        const start = Number(attr(node, 'order') ?? 1);
        return children(node).map((item, index) => `${(Number.isSafeInteger(start) ? start : 1) + index}. ${render(item, depth + 1)}`).join('\n');
      }
      case 'listItem': return inner('\n');
      case 'codeBlock': return `\`\`\`${attr(node, 'language') ?? ''}\n${inner('')}\n\`\`\``;
      case 'blockquote': return inner().split('\n').map(line => `> ${line}`).join('\n');
      default: return inner();
    }
  };
  const text = render(value, 0);
  if (text.length > maxChars) return { text: text.slice(0, maxChars), truncated: true };
  return { text, truncated };
}
