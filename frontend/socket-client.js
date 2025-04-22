// socket-client.js
import van from "./van-1.5.3.min.js";
import { io } from "https://cdn.skypack.dev/socket.io-client@4.8.1";

const { div, text } = van;

// Initialize Socket.IO
const socket = io("http://localhost:3000", {
  transports: ["websocket"],
  reconnection: true,
});

// Define a reactive state for messages using Van's state method
const messages = van.state([]);

// Socket event handlers
socket.on("connect", () => {
  console.log("Connected to Socket.IO server!");
});
socket.on("broadcast", (data) => {
  messages.val = [...messages.val, `Broadcast: ${JSON.stringify(data)}`];
});
socket.on("connect_error", (error) => {
  console.log("Connection error:", error.message);
  messages.val = [...messages.val, `Error: ${error.message}`];
});
socket.on("disconnect", () => {
  console.log("Disconnected from server");
  messages.val = [...messages.val, "Disconnected from server"];
});

// Mount the socket client UI into the element with id "socket"
document.addEventListener("DOMContentLoaded", () => {
  const socketContainer = document.getElementById("socket");
  socketContainer.innerHTML = ""; // Clear container
  const socketUI = div(
    {},
    div(text("VanJS + Socket.IO Demo")),
    div(
      {},
      van.for(messages, (msg) => div({}, text(msg)))
    )
  );
  socketContainer.appendChild(socketUI);
});