import van from './node_modules/vanjs-core/src/van.js';
const { div, button } = van.tags;
// setup DOM
global.document = {
  createElement: () => ({ setAttribute: () => {}, classList: { add: () => {}, remove: () => {} }, _events: {} }),
  createTextNode: () => ({})
};
const s = van.state(false);

const btn = button({
  class: () => "tab-button " + (s.val ? 'active' : ''),
  onclick: () => { s.val = !s.val; }
}, 'Toggle');

console.log(btn.className);
s.val = true;
console.log(btn.className);
