// Source text for the tests that assert the shape of production code (a call, a count of a construct). The Format quality
// gate decides line breaks, indentation and trailing commas, so those tests read the source with them normalized away:
// a reformat never changes what they assert. Approved expectation update, ADOPTION-PLAN.md S4.
export function sourceShape(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/,\s*([)\]])/g, '$1')
    .replace(/,\s*\}/g, ' }')
    .replace(/([([]) /g, '$1')
    .replace(/ ([)\]])/g, '$1');
}
