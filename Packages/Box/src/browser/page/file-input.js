const element = find(index);
if (!element) return 'missing';
const isFile = (node) => !!node && node.localName === 'input' && node.type === 'file';
let input = isFile(element) ? element : element.querySelector && element.querySelector('input[type=file]');
const label = element.closest && element.closest('label');
if (!input && label && isFile(label.control)) input = label.control;
for (let around = element.parentElement, level = 0; !input && around && level < 3; around = around.parentElement, level++) {
  const inside = around.querySelectorAll('input[type=file]');
  if (inside.length === 1) input = inside[0];
}
for (const root of new Set([element.getRootNode(), element.ownerDocument])) {
  if (input || !root.querySelectorAll) continue;
  const all = [...root.querySelectorAll('input[type=file]')];
  if (all.length === 1) input = all[0];
}
return input || 'none';
