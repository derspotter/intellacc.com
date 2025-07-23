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

**IMPORTANT**: This is a Docker-based project. All npm commands, file operations, and development must be run inside the respective Docker containers, not on the host system.

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

## Recent Features Added
- **Event Creation**: Users can create new prediction events via frontend form
- **Enhanced Routing**: Event creation integrated into predictions page
- **Docker Optimization**: Separate dev compose file for faster development
- **Prediction Engine**: Fully functional Rust-based service with professional-grade analytics (port 3001)
- **Metaculus API Integration**: Successfully importing questions with proper JSON parsing
- **Unified Log Scoring System**: Complete implementation of "All-Log + PLL" scoring blueprint
- **Reputation Points System**: User reputation (1-11 scale) with automatic calculation and display
- **Backend Integration**: Full scoring API with automatic calculation when predictions are made/resolved
- **Enhanced Leaderboards**: Multi-timeframe performance tracking with direct database queries
- **Real-time Updates**: WebSocket infrastructure for live score broadcasting
- **SOTA Dark Mode**: Complete dark mode implementation with proper theming
- **Enhanced Predictions List**: Improved styling and layout for predictions display
- **Profile Editor Improvements**: Better button layout and form styling
- **User Profile Navigation**: Clickable usernames in feed that navigate to user profiles
- **Follow Functionality**: Users can follow/unfollow other users from their profile pages
- **Unified Profile System**: Single ProfilePage component handles both current user and public profiles with identical layout
- **Multi-Selection Leaderboards**: Toggle-based leaderboard filtering (Global, Followers, Following, Network)
- **Reputation Display**: Profile cards show reputation points, global rank, and prediction count for all users
- **Feed Visibility Multiplier**: Posts ranked by reputation-weighted visibility for better content discovery

## Database Access Commands
**IMPORTANT**: Database access commands for development and debugging:

```bash
# Basic database access
docker exec intellacc_db psql -U intellacc_user -d intellaccdb

# Run single queries
docker exec intellacc_db psql -U intellacc_user -d intellaccdb -c "SELECT * FROM users;"

# Show table structure
docker exec intellacc_db psql -U intellacc_user -d intellaccdb -c "\d table_name;"

# Common queries
docker exec intellacc_db psql -U intellacc_user -d intellaccdb -c "SELECT COUNT(*) FROM predictions;"
docker exec intellacc_db psql -U intellacc_user -d intellaccdb -c "SELECT COUNT(*) FROM events;"
docker exec intellacc_db psql -U intellacc_user -d intellaccdb -c "SELECT id, username, role FROM users;"
```

**Database Credentials** (from /backend/.env):
- User: `intellacc_user`
- Password: `supersecretpassword`
- Database: `intellaccdb`
- Host: `db` (within Docker network) or `localhost:5432` (from host)

## Database Population Scripts
For testing the reputation system and social features with realistic data:

### Main Population Script
```bash
# Populate database with 1000 users and realistic social network data
docker cp scripts/populate_database.js intellacc_backend:/usr/src/app/
docker exec intellacc_backend node populate_database.js
```

**Generates:**
- 1000 realistic users with diverse profiles
- 35,000+ follow relationships (realistic social network patterns)
- 15,000+ predictions on existing Metaculus events
- 500 posts + 800 comments for feed testing
- 2000+ likes for engagement metrics
- Reputation scores calculated for all users

### Resolved Predictions Script
```bash
# Add historical resolved events for proper reputation testing
docker cp scripts/add_resolved_predictions.js intellacc_backend:/usr/src/app/
docker exec intellacc_backend node add_resolved_predictions.js
```

**Generates:**
- 30 historical resolved events (2021-2023) based on actual outcomes
- 800+ additional resolved predictions with realistic accuracy patterns
- Recalculated reputation scores with sufficient resolved data
- Proper test coverage for the unified log scoring system

**Combined Result**: Over 4,500 resolved predictions (28% resolution rate) providing robust data for testing leaderboards, reputation rankings, and scoring accuracy.

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

### Kelly Criterion Component & Reactive State Issues
**Problem**: Complex reactive components may not re-render when object state changes, causing components to appear/disappear.

**Critical Solutions**:

1. **Force VanJS Reactivity for Object Updates**:
```javascript
// Wrong - VanJS doesn't detect object mutations
kellyData.val = { optimal: 100, edge: 0.2 };

// Correct - Force reactivity with object spread
kellyData.val = {...kellyData.val}; // Forces re-render
```

2. **Direct Input Elements vs Custom Components**:
```javascript
// Custom TextInput components may have prop name mismatches
// Use direct input elements for critical form fields:
input({
  type: 'number',
  value: () => stakeAmount.val, // Reactive binding
  oninput: (e) => {
    stakeAmount.val = e.target.value; // Direct state update
  }
})
```

3. **Button Disable Logic with Debugging**:
```javascript
// Add logging to debug reactive disable states
disabled: () => {
  const disabled = !stakeAmount.val || submitting.val;
  console.log('Button disabled:', disabled, 'value:', stakeAmount.val);
  return disabled;
}
```

4. **Kelly API Integration Pattern**:
```javascript
const getKellySuggestion = async (belief) => {
  const response = await fetch(`/api/kelly?belief=${belief}&user_id=${userId}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  
  if (response.ok) {
    const kelly = await response.json();
    kellyData.val = {
      kelly_optimal: parseFloat(kelly.kelly_suggestion),
      quarter_kelly: parseFloat(kelly.quarter_kelly),
      edge: belief - parseFloat(kelly.current_prob),
      balance: parseFloat(kelly.balance)
    };
    // Critical: Force reactivity
    kellyData.val = {...kellyData.val};
  }
};
```

5. **Slider with Manual DOM Updates (Performance)**:
```javascript
// Avoid reactive slider to prevent re-renders during dragging
let beliefProbability = 0.7; // Plain JS variable

const slider = input({
  type: 'range',
  min: '0.01', max: '0.99', step: '0.01',
  value: beliefProbability
});

// Manual DOM updates for performance
slider.oninput = (e) => {
  beliefProbability = parseFloat(e.target.value);
  // Update display manually
  displayElement.textContent = `${(beliefProbability * 100).toFixed(1)}%`;
  // Debounced API calls
  setTimeout(() => getKellySuggestion(beliefProbability), 300);
};
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

### Unified Log Scoring System Implementation
The system implements the complete "All-Log + PLL" scoring blueprint with professional-grade features:

**Core Scoring Rules (One Log Family):**
- **Binary predictions**: Log loss `L = -ln p_true`
- **Multi-choice**: Penalized Log-Loss (PLL) `L = -ln p_true + [-ln(1/K)] * 1_{argmax ≠ true}`
- **Numeric/Continuous**: Negative log-likelihood `L = -ln f_θ(x_true)` with density clipping at ε = 10⁻⁴

**Reputation System:**
1. **Time-weighting**: Predictions divided into hourly slices with weight `w_s = Δt/T_open`
2. **Peer-relative bonus**: `R = k(Acc_user - Acc_others)` where k approaches 0.5 as forecast count grows
3. **Positive-sum mapping**: `Rep = 10 * tanh(-(Acc + R)) + 1` giving 1-11 scale reputation points

**Database Schema:**
- `predictions.prob_vector` (JSONB) - Probability distributions for all prediction types
- `predictions.raw_log_loss` - Calculated unified log loss scores
- `score_slices` - Time-weighted scoring data per prediction slice
- `user_reputation` - Final reputation points, time-weighted scores, peer bonuses

**Backend Integration:**
- Automatic score calculation when predictions are created/resolved
- Express proxy routes to prediction-engine endpoints (`/api/scoring/*`)
- Background score updates without blocking user responses
- Real-time reputation updates via WebSocket broadcasting

**Frontend API Integration:**
- Complete scoring API service in `api.scoring.*`
- Leaderboard endpoints for reputation rankings
- User reputation stats and calibration data
- Admin functions for manual score recalculation

**Available Scoring Endpoints:**
- GET `/api/scoring/leaderboard` - Unified log scoring leaderboard
- GET `/api/scoring/user/:id/reputation` - User reputation stats with level (Beginner/Novice/Skilled/Expert/Oracle)
- GET `/api/scoring/user/:id/accuracy` - Enhanced accuracy with unified log scoring
- GET `/api/scoring/user/:id/calibration` - Calibration curve data
- POST `/api/scoring/calculate` - Manual score recalculation (admin)
- POST `/api/scoring/time-weights` - Time-weighted score updates (admin)

**Direct Database Leaderboard Endpoints:**
- GET `/api/leaderboard/global` - Global leaderboard (all users)
- GET `/api/leaderboard/followers` - User + their followers leaderboard
- GET `/api/leaderboard/following` - User + people they follow leaderboard
- GET `/api/leaderboard/network` - User + followers + following (network) leaderboard
- GET `/api/leaderboard/rank` - Current user's global rank and reputation stats

**Performance Optimization:**
- In-memory caching with 5-minute TTL for frequently accessed data
- Automatic cache invalidation on data updates
- Batch processing for bulk score recalculations
- Async processing for non-blocking operations

**Metaculus Integration:**
- Daily automated sync with Metaculus.com API
- Manual sync endpoints for immediate updates
- Category-specific synchronization (politics, economics, science, etc.)
- Automatic event creation from imported questions

## Leaderboard & Reputation System

### Multi-Selection Leaderboard Component
**Location**: `/frontend/src/components/predictions/LeaderboardCard.js`

**Features:**
- **Toggle-based filtering**: Users can select Global, Followers, Following independently
- **Network view**: Selecting both Followers + Following creates network leaderboard
- **Real-time updates**: Automatic refresh and live data fetching
- **User rank display**: Shows current user's global rank for Global view
- **Responsive design**: Adapts to mobile with optimized button layout

**API Integration:**
- Direct database queries for maximum performance (no prediction-engine proxy)
- Separate endpoints for each leaderboard type with optimized SQL
- User rank calculation with proper ties handling

### Profile Reputation Display
**Location**: `/frontend/src/components/profile/ProfileCard.js`

**Features:**
- **Universal display**: Shows reputation for both current user and public profiles
- **Comprehensive stats**: Reputation points (1-11 scale), global rank, prediction count
- **Loading states**: Proper loading indicators and error handling
- **Responsive design**: Mobile-optimized layout with proper spacing

**Data Sources:**
- Current user: `/api/leaderboard/rank` (includes rank calculation)
- Public profiles: `/api/scoring/user/:id/reputation` (prediction-engine data)

### Feed Visibility Multiplier
**Location**: `/backend/src/controllers/postController.js`

**Implementation:**
- **Reputation-weighted ranking**: `(1 + 0.15 * LN(1 + Rep)) * time_factor`
- **Automatic calculation**: Applied to both `getPosts` and `getFeed` endpoints
- **Performance optimized**: Direct SQL calculation without additional queries

## Key Directories
- `/frontend/src/components/` - VanJS components organized by feature
  - `/predictions/LeaderboardCard.js` - Multi-selection leaderboard with 4 view types
  - `/profile/ProfileCard.js` - Universal profile card with reputation display
- `/backend/src/controllers/` - API endpoint handlers
  - `scoringController.js` - Prediction-engine proxy endpoints
  - `leaderboardController.js` - Direct database leaderboard queries
  - `postController.js` - Feed with reputation-based visibility
- `/backend/src/services/` - Business logic services (scoringService.js for prediction-engine communication)
- `/backend/src/routes/` - Express route definitions
- `/backend/migrations/` - Database schema files
- `/prediction-engine/` - Rust-based prediction processing with unified log scoring implementation
- `/scripts/` - Database population scripts for testing

## Profile System Architecture

### Component Hierarchy
- **ProfilePage** (`/frontend/src/components/profile/ProfilePage.js`) - Universal profile component
  - Handles both current user (`#profile`) and public user (`#user/:id`) profiles
  - Uses identical layout and styling for consistent UX
  - Conditionally shows edit vs follow functionality

### Reusable Profile Components
- **ProfileCard** (`ProfileCard.js`) - User info display with edit/follow button
- **NetworkTabs** (`NetworkTabs.js`) - Followers/following display for any user
- **FollowButton** (`FollowButton.js`) - Standalone follow/unfollow functionality
- **ProfilePredictions** (`ProfilePredictions.js`) - User's prediction history
- **ProfileEditor** (`ProfileEditor.js`) - Edit form for current user

### DRY Code Principles Applied
- Single ProfilePage component eliminates duplicate layout code
- ProfileCard works for both current user (with edit) and public users (with follow)
- NetworkTabs accepts userId prop to show any user's network
- FollowButton is extracted as reusable component
- Identical CSS classes ensure visual consistency

### Navigation Flow
1. User clicks username in feed → PostItem component
2. Hash changes to `#user/:id` → Router detects user profile route
3. ProfilePage component loads with userId prop
4. API fetches user data, renders with follow functionality
5. All existing components (ProfileCard, NetworkTabs) reused with different props

## VanJS Idiomatic Patterns & Best Practices

### Core Principles
- **Simplicity**: Minimal boilerplate, functional composition
- **Reactivity**: State-driven UI updates with `van.state()`
- **Composability**: Components as functions returning DOM elements
- **Performance**: Stateful binding and selective re-rendering

### State Management
```javascript
// ✅ Correct: Use van.state() for reactive state
const count = van.state(0)
const name = van.state('John')

// ✅ Correct: Update state values directly
count.val = count.val + 1
name.val = 'Jane'

// ❌ Wrong: Never mutate state objects directly
// const user = van.state({name: 'John'})
// user.val.name = 'Jane' // This prevents DOM updates!

// ✅ Correct: Replace entire object for nested state
const user = van.state({name: 'John'})
user.val = {...user.val, name: 'Jane'}
```

### Component Structure
```javascript
// ✅ Correct: Component as function returning DOM
const UserCard = ({user, onFollow}) => {
  const following = van.state(false)
  
  return div({ class: "user-card" }, [
    h3(user.username),
    p(user.bio),
    button({
      onclick: () => {
        following.val = !following.val
        onFollow?.(user.id)
      }
    }, () => following.val ? "Unfollow" : "Follow")
  ])
}

// ❌ Wrong: Don't use classes or complex inheritance
```

### Reactive Patterns
```javascript
// ✅ Correct: Use functions for reactive content
() => user.val ? div("Welcome " + user.val.name) : div("Loading...")

// ✅ Correct: Reactive attributes
button({
  class: () => `btn ${active.val ? 'active' : ''}`,
  disabled: () => loading.val
}, "Click me")

// ✅ Correct: Reactive child nodes
div([
  h1("Users"),
  () => users.val.map(user => UserCard({user}))
])
```

### Event Handling
```javascript
// ✅ Correct: Direct event binding
button({
  onclick: () => count.val++,
  onmouseover: () => hover.val = true
}, "Increment")

// ✅ Correct: Async event handlers
button({
  onclick: async () => {
    loading.val = true
    try {
      await api.saveData()
      success.val = true
    } catch (err) {
      error.val = err.message
    } finally {
      loading.val = false
    }
  }
}, "Save")
```

### Form State Management
```javascript
// ✅ Correct: Separate state for each field (prevents focus loss)
const title = van.state('')
const content = van.state('')

// ❌ Wrong: Single object state causes re-renders
// const form = van.state({title: '', content: ''})
```

### Component Props & Children
```javascript
// ✅ Correct: Use named props, especially for children
Button({
  type: "submit",
  className: "primary",
  children: () => loading.val ? "Saving..." : "Save"
})

// ❌ Wrong: Positional children parameter
// Button({type: "submit"}, () => loading.val ? "Saving..." : "Save")
```

### Conditional Rendering
```javascript
// ✅ Correct: Use functions for conditional content
() => error.val ? div({class: "error"}, error.val) : null

// ✅ Correct: Ternary for simple cases
() => loading.val ? "Loading..." : "Ready"

// ❌ Wrong: Complex nested conditionals
// Avoid deeply nested ternary operators in reactive functions
```

### Performance Optimization
```javascript
// ✅ Correct: Use van.derive() for computed state
const fullName = van.derive(() => `${firstName.val} ${lastName.val}`)

// ✅ Correct: Stateful binding for targeted updates
const updateCounter = (dom) => {
  dom.textContent = count.val
}

// ✅ Correct: Minimize reactive scope
div([
  "Static content",
  () => dynamicContent.val, // Only this part re-renders
  "More static content"
])
```

### Common Anti-Patterns to Avoid
- Never mutate state object properties directly
- Don't use DOM nodes as state values
- Avoid complex conditional logic in reactive functions
- Don't create state inside reactive functions
- Avoid deep component nesting - prefer composition
- Don't use VanJS state for purely local, non-reactive data

## VanX for Advanced Component Nesting & Composition

### When to Use VanX
- Complex nested state objects
- Dynamic list rendering with minimal re-renders
- Global state management
- Calculated/computed properties
- Batch state updates

### VanX Reactive Objects
```javascript
// ✅ Correct: Use VanX for nested state
import { reactive, calc } from "vanx-core"

const appState = reactive({
  user: {
    profile: { name: '', email: '', bio: '' },
    preferences: { theme: 'light', notifications: true }
  },
  posts: [],
  ui: { loading: false, error: null }
})

// ✅ Automatic reactivity for nested properties
appState.user.profile.name = 'John'
appState.ui.loading = true
```

### VanX List Rendering
```javascript
// ✅ Correct: Efficient list rendering with VanX
import { list } from "vanx-core"

const PostsList = () => {
  return list(
    div({ class: "posts-container" }),
    appState.posts,
    (post, deleter) => PostItem({ 
      post, 
      onDelete: deleter 
    })
  )
}

// Automatically updates only changed items
```

### VanX Calculated Fields
```javascript
// ✅ Correct: Computed properties with VanX
const userState = reactive({
  firstName: 'John',
  lastName: 'Doe',
  fullName: calc(() => `${userState.firstName} ${userState.lastName}`),
  posts: [],
  postCount: calc(() => userState.posts.length)
})
```

### VanX Batch Updates
```javascript
// ✅ Correct: Efficient batch updates
import { replace } from "vanx-core"

// Remove completed items efficiently
const clearCompleted = () => {
  replace(appState.todos, list => 
    list.filter(([_, todo]) => !todo.completed)
  )
}

// Batch multiple updates
const updateUserProfile = (newData) => {
  replace(appState.user.profile, () => ({
    ...appState.user.profile,
    ...newData
  }))
}
```

### VanX Component Patterns
```javascript
// ✅ Correct: VanX-powered component with nested state
const UserProfileEditor = () => {
  const formState = reactive({
    fields: { name: '', email: '', bio: '' },
    validation: { hasErrors: false, errors: {} },
    ui: { saving: false, saved: false }
  })

  return Card({
    title: "Edit Profile",
    children: [
      // Form fields automatically reactive
      TextInput({
        value: () => formState.fields.name,
        oninput: (value) => formState.fields.name = value,
        error: () => formState.validation.errors.name
      }),
      
      Button({
        onclick: async () => {
          formState.ui.saving = true
          try {
            await api.updateProfile(formState.fields)
            formState.ui.saved = true
          } catch (err) {
            formState.validation.hasErrors = true
          } finally {
            formState.ui.saving = false
          }
        },
        disabled: () => formState.ui.saving,
        children: () => formState.ui.saving ? "Saving..." : "Save"
      })
    ]
  })
}
```

### Migration Strategy: VanJS → VanX
1. **Simple components**: Keep using vanilla VanJS
2. **Complex state**: Migrate to VanX reactive objects
3. **Dynamic lists**: Use VanX list() for better performance
4. **Global state**: Consolidate with VanX reactive()
5. **Computed values**: Replace manual derivations with VanX calc()

### VanX Best Practices
- Use reactive() for any nested state objects
- Prefer list() over manual array mapping for dynamic content
- Leverage calc() for derived values to avoid manual dependency tracking
- Use replace() for efficient batch updates
- Keep component functions pure - all state in reactive objects

## VanUI Component Library

### Installation & Setup
```javascript
// NPM installation
npm install vanjs-ui

// Import VanUI components
import {Modal, Tabs, Toggle, Tooltip} from "vanjs-ui"

// Or via CDN script tag for quick prototyping
```

### Available VanUI Components

#### Core UI Components
- **Modal**: Overlay windows for dialogs, forms, confirmations
- **Tabs**: Switchable content panels for organizing information
- **Toggle**: On/off switches for boolean settings
- **Tooltip**: Contextual information popups on hover/focus
- **Banner**: Informational headers/footers for announcements
- **FloatingWindow**: Movable, resizable windows for advanced UIs
- **OptionGroup**: Mutually exclusive option selection (radio buttons)
- **MessageBoard**: Notification/alert display system

#### Utility Components
- **Await**: Handles asynchronous data rendering with loading states
- **Choose**: Modal-based selection interface for complex choices

### VanUI Usage Patterns

#### Modal Component
```javascript
// ✅ Correct: Use VanUI Modal instead of custom dialog
import {Modal} from "vanjs-ui"

const UserProfileModal = ({user, isOpen, onClose}) => {
  return Modal({
    closed: () => !isOpen.val,
    title: `${user.username}'s Profile`,
    content: div([
      p(`Email: ${user.email}`),
      p(`Bio: ${user.bio || 'No bio provided'}`)
    ]),
    onClose: () => {
      isOpen.val = false
      onClose?.()
    }
  })
}
```

#### Tabs Component
```javascript
// ✅ Correct: Use VanUI Tabs for profile sections
import {Tabs} from "vanjs-ui"

const ProfileTabs = ({user}) => {
  return Tabs({
    tabsStyle: {backgroundColor: "var(--card-bg)"},
    tabs: [
      {
        text: "Profile",
        content: UserProfileInfo({user})
      },
      {
        text: "Posts", 
        content: UserPostsList({userId: user.id})
      },
      {
        text: "Network",
        content: NetworkTabs({user})
      }
    ]
  })
}
```

#### Toggle Component
```javascript
// ✅ Correct: Use VanUI Toggle for settings
import {Toggle} from "vanjs-ui"

const SettingsPanel = () => {
  const darkMode = van.state(false)
  const notifications = van.state(true)
  
  return div([
    div([
      "Dark Mode: ",
      Toggle({
        on: darkMode,
        color: "var(--success-color)"
      })
    ]),
    div([
      "Notifications: ",
      Toggle({
        on: notifications,
        color: "var(--primary-color)"
      })
    ])
  ])
}
```

#### MessageBoard Component
```javascript
// ✅ Correct: Use VanUI MessageBoard for notifications
import {MessageBoard} from "vanjs-ui"

const AppNotifications = () => {
  const messages = van.state([])
  
  const addMessage = (text, type = 'info') => {
    messages.val = [...messages.val, {text, type, id: Date.now()}]
  }
  
  return MessageBoard({
    messages,
    closable: true,
    boardStyle: {position: "fixed", top: "1rem", right: "1rem"}
  })
}
```

#### Await Component
```javascript
// ✅ Correct: Use VanUI Await for async data
import {Await} from "vanjs-ui"

const UserProfile = ({userId}) => {
  const userPromise = api.users.getUser(userId)
  
  return Await({
    value: userPromise,
    container: div({class: "profile-container"}),
    Loading: () => div({class: "loading"}, "Loading user profile..."),
    Error: (error) => div({class: "error"}, `Error: ${error.message}`),
    Success: (user) => UserProfileCard({user})
  })
}
```

### VanUI Styling & Theming

#### Component Style Overrides
```javascript
// ✅ Correct: Customize VanUI components with style props
Modal({
  title: "Confirm Action",
  modalStyle: {
    backgroundColor: "var(--card-bg)",
    border: "1px solid var(--border-color)",
    borderRadius: "var(--border-radius)"
  },
  titleStyle: {
    color: "var(--text-color)",
    borderBottom: "1px solid var(--border-color)"
  },
  contentStyle: {
    padding: "1rem",
    color: "var(--text-color)"
  }
})
```

#### Theme Integration
```javascript
// ✅ Correct: Create theme-aware VanUI components
const ThemedModal = (props) => Modal({
  ...props,
  modalStyle: {
    backgroundColor: "var(--card-bg)",
    border: "1px solid var(--border-color)",
    color: "var(--text-color)",
    ...props.modalStyle
  }
})
```

### Migration Priority: Custom → VanUI

#### High Priority (Replace Immediately)
- Custom modal/dialog components → `VanUI.Modal`
- Custom tab interfaces → `VanUI.Tabs` 
- Custom toggle switches → `VanUI.Toggle`
- Custom tooltips → `VanUI.Tooltip`
- Loading/async states → `VanUI.Await`

#### Medium Priority (Consider for Future)
- Notification systems → `VanUI.MessageBoard`
- Radio button groups → `VanUI.OptionGroup`
- Announcement banners → `VanUI.Banner`

#### Low Priority (Keep Custom if Simple)
- Basic buttons, inputs, cards (if already well-implemented)
- Simple layout components

### VanUI Best Practices
- Always prefer VanUI components over custom implementations
- Use style override props to maintain design consistency
- Leverage VanUI's reactive state management
- Combine VanUI components with VanX for complex state
- Customize via CSS custom properties for theme integration
- Use VanUI.Await for any asynchronous data loading
