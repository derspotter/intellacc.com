// socket-client.js
import { io } from "https://cdn.skypack.dev/socket.io-client@4.8.1";
const { div, text } = van;

const socket = io("http://localhost:3000", {
  transports: ["websocket"],
  reconnection: true,
});

// Reactive state for messages
const messages = van.state([]);

// On connect, send a test message
socket.on("connect", () => {
  console.log("Connected to Socket.IO server!");
  socket.emit("test-message", {
    message: "Hello from VanJS client!",
    timestamp: new Date().toISOString()
  });
});

// On broadcast, push messages to our state
socket.on("broadcast", (data) => {
  messages.val = [...messages.val, `Broadcast: ${JSON.stringify(data)}`];
});

// Handle new posts
socket.on("newPost", (data) => {
  messages.val = [...messages.val, `New Post: ${JSON.stringify(data)}`];
});

// Handle connection errors
socket.on("connect_error", (error) => {
  console.log("Connection error:", error.message);
  messages.val = [...messages.val, `Error: ${error.message}`];
});

// On disconnect, log and push to state
socket.on("disconnect", () => {
  console.log("Disconnected from server");
  messages.val = [...messages.val, "Disconnected from server"];
});

// Create a reactive UI that renders messages
document.getElementById("app").appendChild(
  div(
    div(text("VanJS + Socket.IO Demo")),
    div(
      van.for(messages, (msg) => div(text(msg)))
    )
  )
);