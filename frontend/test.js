import van from './van-1.5.3.min.js';
const { div, h1, p } = van.tags;

export function createTest() {
  return div(
    { style: "background:red; color:white; padding:1rem; border: 3px solid yellow;" },
    [
      h1({}, "Test Component"),
      p({}, "If you see this text, rendering works!")
    ]
  );
}