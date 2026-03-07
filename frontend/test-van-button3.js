import van from './node_modules/vanjs-core/src/van.js';
// setup DOM
global.document = {
  createElement: () => ({ setAttribute: function(n, v) { this[n] = v; }, classList: { add: () => {}, remove: () => {} }, _events: {} }),
  createTextNode: () => ({})
};
const s = van.state(false);

const btn = van.tags.button({
  class: () => "tab-button " + (s.val ? 'active' : '')
}, 'Toggle');

console.log(btn.class);
s.val = true;
console.log(btn.class);
