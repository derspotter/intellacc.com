import van from "./van-1.5.3.min.js";
const { div, table, tr, td } = van.tags;

export async function createDesign1() {
  const gridContainer = div({ class: "grid-container" },
    div({ class: "title" }, 
      "INTELLACC.COM",
      div({ class: "subtitle-text" }, "accelerating collective intelligence")
    ),
    div({ class: "version-label" }, "Version"),
    div({ class: "version-value" }, "v0.1"),
    div({ class: "updated-label" }, "Updated"),
    div({ class: "updated-value" }, "2025-01-25"),
    div({ class: "license-label" }, "License"),
    div({ class: "license-value" }, "MIT"),
    div({ class: "author-label" }, "Author"),
    div({ class: "author-value" }, "Justus Spott")
  );
  
  // Wrap the grid container in the top wrapper
  const topWrapper = div({ class: "top-wrapper" }, gridContainer);

  const mainContent = div({ class: "main-content" },
    table({ class: "table" }, [
      tr(null, [
        td(null, "CONTENTS"),
        td(null, "INTRODUCTION"),
        td(null, "The Basics"),
        td(null, "Lists"),
        td(null, "Tables"),
        td(null, "Forms"),
        td(null, "Grids"),
        td(null, "ASCII Drawings"),
        td(null, "Media"),
        td(null, "Discussion")
      ])
    ]) 
  );

  const leftSidebar = div({ class: "leftblackbox" }, 
    div({ class: "sidebar-content" }, [
      div({ class: "sidebar-item" }, "Introduction"),
      div({ class: "sidebar-item" }, "The Basics"),
      div({ class: "sidebar-item" }, "Lists"),
      div({ class: "sidebar-item" }, "Tables"),
      div({ class: "sidebar-item" }, "Forms"),
      div({ class: "sidebar-item" }, "Grids"),
      div({ class: "sidebar-item" }, "ASCII Drawings"),
      div({ class: "sidebar-item" }, "Media"),
      div({ class: "sidebar-item" }, "Discussion")
    ])
  );

  const mainWrapper = div({ class: "main-wrapper" }, leftSidebar, mainContent);

  const wrapper = div({ class: "body" }, topWrapper, mainWrapper);

  
  // Return the complete layout
  return wrapper;
}