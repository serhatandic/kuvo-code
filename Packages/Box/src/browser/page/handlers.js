/*@ every-element */
const names = ['onclick', 'onmousedown', 'onmouseup', 'ondblclick'];
const found = [];
everyElement((element, place) => {
  const set = names.filter((name) => typeof element[name] === 'function' && !element.hasAttribute(name));
  if (set.length) found.push([place, element.localName, set]);
});
return found;
