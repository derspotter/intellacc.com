# Intellacc Development Guide

## Project Overview
Intellacc is a prediction and social platform where users can:
- Create events for others to predict on
- Make predictions on events with confidence levels
- Post and comment in a social feed
- Follow other users and track prediction accuracy
- Place bets on assigned predictions
- Admin features for event management
- **LMSR Market System**: Full automated market making with real-time probability updates

## Architecture
- **Frontend**: VanJS-based SPA with Vite dev server (port 5173)
- **Backend**: Express.js API with Socket.io for real-time features (port 3000)
- **Database**: PostgreSQL with direct SQL queries
- **Prediction Engine**: Rust-based service (port 3001) - LMSR market maker
- **Reverse Proxy**: Caddy for production (ports 80/443)

**IMPORTANT**: This is a Docker-based project. All npm commands, file operations, and development must be run inside the respective Docker containers, not on the host system.

## Project Build Configuration
- We are not using cargo but build the @prediction-engine/ in docker

## Quick Start (Docker - Recommended)
```bash
# Create network (run once)
docker network create intellacc-network

# Start full stack including prediction engine
docker compose up -d

# Access the application
# Frontend: http://localhost:5173
# Backend API: http://localhost:3000/api
# Prediction Engine: http://localhost:3001/health
# Health check: http://localhost:3000/api/health-check

# Stop services
docker compose down
```

## Mobile Implementation (Phase 1 Complete)
- **Mobile Navigation**: Hamburger menu + slide-out sidebar + bottom nav
- **Responsive Breakpoints**: <768px (mobile), 768-1024px (tablet), >1024px (desktop)
- **Touch Targets**: All buttons/inputs minimum 44px height
- **Key Files Modified**:
  - `frontend/src/utils/deviceDetection.js` - Mobile detection utility
  - `frontend/src/components/layout/Sidebar.js` - Mobile-responsive sidebar
  - `frontend/src/components/mobile/MobileHeader.js` - Mobile header with hamburger
  - `frontend/src/components/mobile/BottomNav.js` - Bottom navigation bar
  - `frontend/src/components/layout/MainLayout.js` - Responsive layout wrapper
  - `frontend/styles.css` - Mobile styles and media queries

## Development Reminders
- When you make a screenshot with browsertools mcp server, always remember to look at it!
- please remember to always look at screenshots when you made them. they are being saved in /home/justus/Nextcloud/intellacc.com//screenshots
- Always look at screenshots after making them in /home/justus/Nextcloud/intellacc.com//screenshots