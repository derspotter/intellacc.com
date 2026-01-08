# Intellacc Development Agent Guide

## Commands
### Frontend
- Dev: `npm run dev` (Vite dev server)
- Build: `npm run build`
- Test: `npm test` (run all tests)
- Test single: `npm test -- path/to/test`

### Backend
- Dev: `npm run dev` (nodemon)
- Start: `npm start` (production)
- Test: `npm test` (all tests)
- Test single: `npm test -- path/to/test`

## Code Style
- Indentation: 2 spaces
- Frontend: ES6 imports, VanJS component architecture, minimal JS (prefer basic HTML)
- Backend: CommonJS imports, MVC pattern, PostgreSQL with direct SQL
- Naming: camelCase for variables/functions/files
- Strings: Single quotes preferred
- Error Handling: Try/catch with appropriate HTTP status codes
- Authentication: JWT tokens with middleware validation
- API: RESTful endpoints
- Real-time: Socket.io