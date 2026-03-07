import van from './node_modules/vanjs-core/src/van.js';
const { div, button } = van.tags;

const s = van.state(false);

const btn = button({
  class: () => \`tab-button \${s.val ? 'active' : ''}\`,
  onclick: () => { s.val = !s.val; }
}, 'Toggle');

console.log(btn.outerHTML);
s.val = true;
console.log(btn.outerHTML);
