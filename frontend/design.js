import van from './van-1.5.3.min.js';
const { div, header, main, section, h2, ul, li, a, p } = van.tags;

// (Remove or comment out the inline CSS injection)
// if (!document.getElementById("design-style")) { … }

// Build the header component using classes defined in styles.css
const headerElem = header({ class: "header-box" },
  div({ class: "header-content" }, [
    div({ class: "header-item title design1" }, "intellacc.com"),
    div({ class: "header-item" }, ["Version", div({}, "v0.1")]),
    div({ class: "header-item" }, ["License", div({}, "MIT")]),
    div({ class: "subtitle design1" }, "accelerating collective intelligence")
  ])
);

// Build the contents component
const contentsElem = div({ class: "contents" }, [
  h2({ class: "design1" }, "CONTENTS"),
  ul({ class: "design1" },
    li({ class: "design1" }, a({ href: "#introduction", class: "design1" }, "Introduction")),
    li({ class: "design1" }, a({ href: "#basics", class: "design1" }, "The Basics")),
    li({ class: "design1" }, a({ href: "#lists", class: "design1" }, "Lists")),
    li({ class: "design1" }, a({ href: "#tables", class: "design1" }, "Tables")),
    li({ class: "design1" }, a({ href: "#forms", class: "design1" }, "Forms")),
    li({ class: "design1" }, a({ href: "#grids", class: "design1" }, "Grids")),
    li({ class: "design1" }, a({ href: "#ascii", class: "design1" }, "ASCII Drawings")),
    li({ class: "design1" }, a({ href: "#media", class: "design1" }, "Media")),
    li({ class: "design1" }, a({ href: "#discussion", class: "design1" }, "Discussion"))
  )
]);

// Build the introduction section content
const sectionElem = section({ id: "introduction" }, [
  h2({ class: "design1" }, "INTRODUCTION"),
  p({ class: "design1" }, "Monospace fonts are dear to many of us. Some find them more readable, consistent, and beautiful, than their proportional alternatives. Maybe we're just brainwashed from spending years in terminals? Or are we hopelessly nostalgic? I'm not sure. But I like them, and that's why I started experimenting with all-monospace Web."),
  p({ class: "design1" }, "On this page, I use a monospace grid to align text and draw diagrams. It's generated from a simple Markdown document (using Pandoc), and the CSS and a tiny bit of JavaScript render it on a grid. The page is responsive, shrinking in character-sized steps. Standard elements should just work, at least that's the goal."),
  p({ class: "design1" }, "All right, but is this even a good idea? It's a technical and creative challenge—and I like the aesthetic. If you'd like to use it, feel free to fork or copy the bits you need, respecting the license. I might update it over time with improvements and support for more standard elements.")
]);

// Export a function returning the design component
export function createDesign() {
  return div(null, [
    headerElem,
    main({ class: "main-content" }, [
      contentsElem,
      sectionElem
    ])
  ]);
}