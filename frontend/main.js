// frontend/main.js

import { html, render, useState, useEffect } from "https://unpkg.com/vanjs@latest";

// App Component
const App = () => {
  const [message, setMessage] = useState("Loading...");

  useEffect(() => {
    fetch("/api/")  // Assuming Caddy proxies /api to backend
      .then((res) => res.text())
      .then((data) => setMessage(data))
      .catch((err) => setMessage("Error fetching data"));
  }, []);

  return html`<div>${message}</div>`;
};

// Render the App component into the #app div
render(App, document.getElementById("app"));
