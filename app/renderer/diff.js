// Minimal line diff for the Changes panel: trims the common prefix and suffix,
// then marks the remaining old lines as removed and new lines as added.
export function diffLines(before, after, maxLines = 300) {
  const a = String(before ?? '').split('\n');
  const b = String(after ?? '').split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const out = [];
  const ctxBefore = Math.max(0, start - 2);
  for (let i = ctxBefore; i < start; i++) out.push({ type: 'ctx', text: '  ' + a[i] });
  for (let i = start; i <= endA; i++) out.push({ type: 'del', text: '- ' + a[i] });
  for (let i = start; i <= endB; i++) out.push({ type: 'add', text: '+ ' + b[i] });
  for (let i = endA + 1; i <= Math.min(a.length - 1, endA + 2); i++) out.push({ type: 'ctx', text: '  ' + a[i] });
  if (out.length > maxLines) {
    return out.slice(0, maxLines).concat([{ type: 'ctx', text: `… ${out.length - maxLines} more lines` }]);
  }
  return out;
}
