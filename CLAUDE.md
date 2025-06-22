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
- **Brier Score Implementation**: Industry-standard prediction accuracy measurement
- **Enhanced Leaderboards**: Multi-timeframe performance tracking with caching
- **Real-time Updates**: WebSocket infrastructure for live score broadcasting
- **SOTA Dark Mode**: Complete dark mode implementation with proper theming
- **Enhanced Predictions List**: Improved styling and layout for predictions display
- **Profile Editor Improvements**: Better button layout and form styling
- **User Profile Navigation**: Clickable usernames in feed that navigate to user profiles
- **Follow Functionality**: Users can follow/unfollow other users from their profile pages
- **Unified Profile System**: Single ProfilePage component handles both current user and public profiles with identical layout

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

### Enhanced Prediction Engine Integration
The Rust-based prediction engine provides professional-grade features:

**Core Scoring:**
- Brier score calculations for proper prediction accuracy
- Calibration scoring for confidence interval analysis
- Multi-timeframe accuracy (daily, weekly, monthly, all-time)
- Time-weighted scoring with decay for recent predictions

**Real-time Features:**
- WebSocket connections for live leaderboard updates
- Real-time score recalculation on prediction resolution
- Live broadcasting of sync events and score changes

**Metaculus Integration:**
- Daily automated sync with Metaculus.com API
- Manual sync endpoints for immediate updates
- Category-specific synchronization (politics, economics, science, etc.)
- Automatic event creation from imported questions

**Domain Expertise:**
- User expertise tracking across different prediction topics
- Domain-specific leaderboards (politics expert, tech expert, etc.)
- Cross-domain performance comparison
- Minimum prediction thresholds for expertise qualification

**Performance Optimization:**
- In-memory caching with 5-minute TTL for frequently accessed data
- Automatic cache invalidation on data updates
- Batch processing for bulk score recalculations
- Async processing for non-blocking operations

**Available Endpoints:**
- GET /enhanced-leaderboard - Leaderboard with Brier scores
- GET /user/:id/enhanced-accuracy - Full user analytics
- GET /user/:id/calibration - Calibration curve data
- GET /user/:id/expertise - Domain-specific expertise
- GET /domain/:name/experts - Top experts in domain
- GET /metaculus/sync - Manual Metaculus sync
- GET /ws - WebSocket for real-time updates

## Key Directories
- `/frontend/src/components/` - VanJS components organized by feature
- `/backend/src/controllers/` - API endpoint handlers
- `/backend/src/routes/` - Express route definitions
- `/backend/migrations/` - Database schema files
- `/prediction-engine/` - Rust-based prediction processing (optional)

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
