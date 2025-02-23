# Intellacc

Intellacc is a social network platform that combines prediction markets with traditional social media features. Users make predictions on various topics, and their visibility is determined by the accuracy and confidence of their predictions.

## Features

- User authentication and profiles
- Create and manage posts with text and images
- Participate in prediction markets
- Leaderboards based on prediction accuracy

## Technologies

- **Frontend**: VanJS, Vite
- **Backend**: Node.js, Express
- **Database**: PostgreSQL
- **Real-Time Communication**: Socket.IO
- **Reverse Proxy**: Caddy
- **Containerization**: Docker, Docker Compose

## Implemented Functions (So Far)

- **Reactive Frontend with VanJS**  
  The frontend is built with VanJS to provide a lightweight, reactive user interface. A reactive state mechanism is implemented to update the UI seamlessly when data changes. For example, the main application creates a message state that updates after fetching data from the backend.

- **Real-Time Communication via Socket.IO**  
  The frontend connects to the backend using Socket.IO. This connection allows real-time features such as:
  - Emitting a `test-message` upon connection to verify communication.
  - Listening for broadcast events and new posts from the backend.
  - Displaying real-time updates in the UI.
  
- **API Integration**  
  The frontend fetches data from the `/api/` endpoint (proxied by Caddy) to display dynamic content. This basic API integration sets the stage for more advanced interactions as the project develops.

## Getting Started

### Prerequisites

- Docker and Docker Compose installed on your machine

### Installation

1. **Clone the repository:**

   ```sh
   git clone https://github.com/yourusername/intellacc.git
   cd intellacc
   ```

2. **Set up your environment variables:**  
   Create the necessary `.env` files for backend configuration (e.g., database credentials).

3. **Start the services with Docker Compose:**

   For the backend:

   ```sh
   cd backend
   docker compose up -d
   ```

   For the frontend:

   ```sh
   cd frontend
   docker compose up --build -d
   ```

4. **Access the application:**  
   - Frontend: [http://localhost:5173](http://localhost:5173)
   - Backend API (proxied by Caddy): [http://localhost:80](http://localhost:80) (if configured)

## Future Development

- Extend the real-time communication to update posts and predictions live.
- Build out user authentication and profile management.
- Enhance the API and integrate more prediction market features.
- Implement a comprehensive UI layout with improved user experience.
