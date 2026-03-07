import van from './node_modules/vanjs-core/src/van.js';
const { div, p, button } = van.tags;
const s = van.state('a');
const renderContent = () => {
    if (s.val === 'a') return p('content A');
    return p('content B');
}
const app = div(
    () => div(renderContent)
);
console.log(app.outerHTML);
