# Intellacc Development Guide

## Commands
### Frontend
- Build/Dev: `npm run dev` (Vite dev server)
- Build Prod: `npm run build`
- Docker: `docker-compose up` (in frontend directory)

### Backend
- Dev: `npm run dev` (nodemon)
- Start: `npm start` (production)
- Test: `npm test` (Jest)
- Docker: `docker-compose up` (in backend directory)

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