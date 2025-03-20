import van from 'vanjs-core';
const { footer, div, a } = van.tags;

/**
 * Application footer component
 * @returns {HTMLElement} Footer element
 */
export default function Footer() {
  return footer({ class: "footer" }, [
    div({ class: "footer-content" }, [
      div({ class: "copyright" }, `© ${new Date().getFullYear()} Intellacc`),
      div({ class: "links" }, [
        a({ href: "#about" }, "About"),
        a({ href: "#terms" }, "Terms"),
        a({ href: "#privacy" }, "Privacy")
      ])
    ])
  ]);
}