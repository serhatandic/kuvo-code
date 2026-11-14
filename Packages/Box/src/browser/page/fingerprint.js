const fingerprint = (element) => {
  let text = '';
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  while (text.length < 200 && walker.nextNode()) text += walker.currentNode.data + ' ';
  const attribute = (name) => element.getAttribute(name) || '';
  return [element.localName, attribute('type'), attribute('name'), attribute('role'), attribute('href'),
    text.replace(/\s+/g, ' ').trim().slice(0, 80).replace(/\d+/g, '#')].join('|');
};

