const element = find(index);
if (!element) return '';
element.scrollIntoView({ block: 'center', inline: 'nearest' });
const r = element.getBoundingClientRect();
let x = r.left, y = r.top;
// In a frame: plus where the frame's content is, out to the page's own window.
for (let view = viewOf(element); view !== window && view.frameElement; view = view.parent) {
  const frame = view.frameElement, box = frame.getBoundingClientRect(), style = view.parent.getComputedStyle(frame);
  x += box.left + frame.clientLeft + (parseFloat(style.paddingLeft) || 0);
  y += box.top + frame.clientTop + (parseFloat(style.paddingTop) || 0);
}
return JSON.stringify({ x, y, width: r.width, height: r.height });
