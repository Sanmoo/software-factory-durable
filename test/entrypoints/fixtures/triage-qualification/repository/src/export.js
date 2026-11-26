// CSV export of a cart. Design: docs/design/export.md.
const field = value => (/[",]/.test(String(value)) ? `"${String(value).replaceAll('"', '""')}"` : String(value));

export function toCsv(items) {
  const lines = items.map(item => [item.name, item.price, item.quantity ?? 1].map(field).join(','));
  return ['name,price,quantity', ...lines].join('\n');
}
