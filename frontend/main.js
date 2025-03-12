// frontend/main.js

import van from "./van-1.5.3.min.js";
const { add, state, tags } = van;
const { div } = tags;

// Create a reactive state for the message
const message = state("Loading...");

// Fetch data and update the state
fetch("/api/")  // Assuming Caddy proxies /api to backend
  .then((res) => res.text())
  .then((data) => (message.val = data))
  .catch((err) => (message.val = "Error fetching data"));

// App Component returns a template that uses the reactive state
// Using the tags API to create a <div> element that displays the message.
// The syntax depends on your VanJS version; here we simply pass the state as a child.
const App = () => div(message);

// Mount the component into the #app div
add(App(), document.getElementById("app"));