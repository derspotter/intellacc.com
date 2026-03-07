import van from './node_modules/vanjs-core/src/van.js';
const { button, div } = van.tags;
const s = van.state(false);

const el = div(
  button({
    class: () => s.val ? "a active" : "a",
    onclick: () => s.val = !s.val
  }, "btn")
);
console.log(el.outerHTML);
s.val = true;
console.log(el.outerHTML);
