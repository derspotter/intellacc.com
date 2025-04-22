// design2.js
import van from "./van-1.5.3.min.js";
const { div, h2, p, ul, li, a } = van.tags;

/**
 * Creates the "design2" layout, fetches posts from `/api/posts`,
 * and displays them in a Tufte-like style.
 *
 * @returns {Promise<HTMLElement>}
 */
export async function createDesign2() {
  // 1. Fetch posts from your backend
  let posts = [];
  try {
    const response = await fetch("/api/posts");
    if (!response.ok) {
      console.error("Failed to fetch posts:", response.status);
    } else {
      posts = await response.json();
    }
  } catch (err) {
    console.error("Error fetching posts:", err);
  }

  // 2. Build the red sidebar on the left
  const sidebar = div({ class: "red-sidebar" });

  // 3. Build the main content container
  //    Let’s display each post title in a bullet list
  const postItems = posts.map((post) =>
    li({ class: "design2" },
      a({ class: "design2", href: "#" }, post.title || "Untitled Post")
    )
  );

  // 4. The content area (like Tufte’s main column)
  const content = div({ class: "content design2" },
    h2({ class: "title design2" }, "Tufte-Style Posts"),
    p({ class: "subtitle design2" }, "Subtitle or tagline can go here"),

    p({ class: "design2" },
      "Below is a list of recent posts, displayed in a Tufte-like layout."
    ),
    ul({ class: "design2" }, postItems),

    p({ class: "design2" },
      "Click a post title to view more details (placeholder example)."
    )
  );

  // 5. Return a container holding both the sidebar and main content
  return div(
    sidebar,
    content
  );
}
