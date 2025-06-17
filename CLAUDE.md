# Intellacc Development Guide

## Project Overview
Intellacc is a prediction and social platform where users can:
- Create events for others to predict on
- Make predictions on events with confidence levels
- Post and comment in a social feed
- Follow other users and track prediction accuracy
- Place bets on assigned predictions
- Admin features for event management

## Architecture
- **Frontend**: VanJS-based SPA with Vite dev server (port 5173)
- **Backend**: Express.js API with Socket.io for real-time features (port 3000)
- **Database**: PostgreSQL with direct SQL queries
- **Prediction Engine**: Rust-based service (port 3001) - optional for development
- **Reverse Proxy**: Caddy for production (ports 80/443)

## Quick Start (Docker - Recommended)
```bash
# Create network (run once)
docker network create intellacc-network

# Start development environment (without prediction engine for faster builds)
docker compose -f docker-compose-dev.yml up -d

# OR start full stack including prediction engine
docker compose up -d

# Access the application
# Frontend: http://localhost:5173
# Backend API: http://localhost:3000/api
# Prediction Engine: http://localhost:3001/health
# Health check: http://localhost:3000/api/health-check

# Stop services
docker compose -f docker-compose-dev.yml down  # or docker compose down for full stack
```

## Development Commands
### Docker
- Full stack: `docker compose up -d` (includes prediction engine - slow build)
- Dev stack: `docker compose -f docker-compose-dev.yml up -d` (faster, no prediction engine)
- Logs: `docker logs intellacc_backend` or `docker logs intellacc_frontend`
- Database: PostgreSQL accessible on port 5432

### Frontend (if running locally)
- Dev server: `npm run dev` (Vite, port 5173)
- Build: `npm run build`
- Test: `npm test`

### Backend (if running locally)
- Dev: `npm run dev` (nodemon with auto-reload)
- Start: `npm start` (production)
- Test: `npm test` (Jest)

## Recent Features Added
- **Event Creation**: Users can create new prediction events via frontend form
- **Enhanced Routing**: Event creation integrated into predictions page
- **Docker Optimization**: Separate dev compose file for faster development
- **Prediction Engine**: Rust-based service for prediction accuracy calculations (port 3001)
- **SOTA Dark Mode**: Complete dark mode implementation with proper theming
- **Enhanced Predictions List**: Improved styling and layout for predictions display
- **Profile Editor Improvements**: Better button layout and form styling

## Code Style
- Indentation: 2 spaces
- Frontend: ES6 imports, VanJS component architecture
- Backend: CommonJS imports, MVC pattern, PostgreSQL with direct SQL
- Naming: camelCase for variables/functions/files
- Strings: Single quotes preferred
- Error handling: Try/catch with appropriate HTTP status codes
- Authentication: JWT tokens, validated through middleware
- API: RESTful design with resource-focused endpoints
- Socket.io for real-time communication

## VanJS Common Patterns & Solutions

### Form Input State Management
**Problem**: When using a single state object for form fields, reassigning the entire object causes form re-renders and loses input focus.

**Wrong approach**:
```javascript
const formState = van.state({ title: '', details: '' });
// This causes re-renders and focus loss:
formState.val = {...formState.val, title: e.target.value};
```

**Correct approach**: Use separate van.state() for each form field:
```javascript
const title = van.state('');
const details = van.state('');
// Direct assignment maintains focus:
title.val = e.target.value;
```

### Button Component Content
**Problem**: Button content not displaying when passed incorrectly to custom Button components.

**Wrong approach**:
```javascript
Button({
  type: "submit",
  className: "submit-button"
}, () => submitting.val ? "Creating..." : "Create")  // ❌ Second parameter
```

**Correct approach**: Use the `children` prop:
```javascript
Button({
  type: "submit", 
  className: "submit-button",
  children: () => submitting.val ? "Creating..." : "Create"  // ✅ Named prop
})
```

### Dark Mode Implementation
**Approach**: Use CSS custom properties for consistent theming
```css
:root {
  --card-bg: #ffffff;
  --text-color: #000;
  --border-color: #000;
}

body.dark-mode {
  --card-bg: #1e1e1e;
  --text-color: #e0e0e0;
  --border-color: #444;
}
```

### Prediction Engine Integration
The Rust-based prediction engine provides:
- User accuracy calculations
- Leaderboard functionality  
- Real-time prediction processing
- Health monitoring endpoints

## Key Directories
- `/frontend/src/components/` - VanJS components organized by feature
- `/backend/src/controllers/` - API endpoint handlers
- `/backend/src/routes/` - Express route definitions
- `/backend/migrations/` - Database schema files
- `/prediction-engine/` - Rust-based prediction processing (optional)