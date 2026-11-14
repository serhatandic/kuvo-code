const element = find(index);
if (!element) return missing(index);
document.getElementById('playwright-highlight-container')?.remove();
element.scrollIntoView({ block: 'center', inline: 'nearest' });
const view = viewOf(element);
const rect = element.getBoundingClientRect();
const options = { bubbles: true, cancelable: true, composed: true, view, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0 };
for (const type of ['pointerover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
  element.dispatchEvent(type.startsWith('pointer') ? new view.PointerEvent(type, options) : new view.MouseEvent(type, options));
}
if (typeof element.focus === 'function') element.focus();
element.click();
return 'ok';
