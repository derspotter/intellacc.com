import van from 'vanjs-core';
const { div } = van.tags;
// import Header from './Header'; 
import Sidebar from './Sidebar';

/**
 * Main layout component that provides the application shell
 * @param {Object} props - Component props
 * @param {any} props.children - Content to render in the main area
 * @returns {HTMLElement} Main layout element
 */
export default function MainLayout({ children }) {
  return div({ class: "app-container" }, [
    div({ class: "wrapper" }, [
      // Header(), 
      div({ class: "content-container" }, [
        Sidebar(),
        div({ class: "main-content" }, children)
      ])
    ])
  ]);
}