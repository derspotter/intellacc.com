# Intellacc Mobile & PWA Implementation Plan

## 1. Current State Analysis

### Mobile UX Pain Points
- **Navigation**: Fixed 25% width sidebar doesn't collapse on mobile
- **Touch Targets**: Buttons and links potentially too small (<44px)
- **Forms**: Input fields not optimized for mobile keyboards
- **Layout**: Content doesn't reflow properly on small screens
- **Performance**: No offline capability, requires constant connection
- **Engagement**: No push notifications for real-time updates

### Existing Mobile Support
- Basic viewport meta tag configured
- Some media queries at 768px, 480px, 1200px
- Partial responsive styles for some components
- Messages and leaderboard have mobile breakpoints

## 2. User Requirements & Use Cases

### Primary Mobile Use Cases
1. **Quick Predictions**: Make/update predictions on the go
2. **Check Results**: View prediction outcomes and accuracy
3. **Social Feed**: Browse and interact with posts
4. **Notifications**: Get alerts for prediction results, messages
5. **Market Trading**: Quick stake updates on LMSR markets
6. **Portfolio Monitoring**: Check RP balance and positions

### User Personas
- **Active Trader**: Needs quick access to markets, real-time updates
- **Casual Predictor**: Weekly assignments, occasional checks
- **Social User**: Focus on feed, messages, and following others
- **Analytics User**: Track performance, leaderboard position

## 3. PWA Feature Priorities

### High Priority (Phase 1)
1. **Mobile Navigation**
   - Collapsible hamburger menu
   - Bottom navigation bar for key actions
   - Swipe gestures for navigation

2. **Installability**
   - Web App Manifest
   - Install prompts at strategic moments
   - App icons and splash screens

3. **Offline Basics**
   - Cache static assets (CSS, JS, images)
   - Offline page for no connection
   - Cache user's own predictions

### Medium Priority (Phase 2)
4. **Push Notifications**
   - Prediction resolved notifications
   - New message alerts
   - Market movement alerts (significant changes)
   - Weekly assignment reminders

5. **Enhanced Offline**
   - Cache recent feed posts
   - Queue actions for sync when online
   - Offline prediction drafts

### Low Priority (Phase 3)
6. **Advanced Features**
   - Background sync for data updates
   - Share Target API for sharing to app
   - File upload optimization
   - Periodic background sync

## 4. Technical Architecture

### Mobile Navigation Design
```
Mobile (<768px):
┌─────────────────────────┐
│ ☰  Intellacc      🔔 👤 │ <- Fixed header
├─────────────────────────┤
│                         │
│     Main Content        │ <- Scrollable
│                         │
├─────────────────────────┤
│ 🏠  📊  ➕  💬  👤     │ <- Bottom nav (key actions)
└─────────────────────────┘

Tablet (768px-1024px):
- Collapsible sidebar with overlay
- Hamburger menu toggle

Desktop (>1024px):
- Current fixed sidebar
```

### PWA Architecture
```
/
├── manifest.json          # PWA manifest
├── service-worker.js      # Service worker
├── offline.html          # Offline fallback
├── frontend/
│   ├── src/
│   │   ├── pwa/
│   │   │   ├── install.js     # Install prompt handler
│   │   │   ├── notifications.js # Push notification manager
│   │   │   └── sync.js        # Background sync handler
│   │   └── components/
│   │       ├── mobile/
│   │       │   ├── MobileNav.js
│   │       │   ├── BottomNav.js
│   │       │   └── MobileMenu.js
```

## 5. Offline Strategy

### Cache Strategy
1. **Cache First** (Static Assets)
   - CSS, JS, fonts, logos
   - Update in background

2. **Network First** (Dynamic Content)
   - API calls, real-time data
   - Fall back to cache if offline

3. **Stale While Revalidate** (User Content)
   - Profile data, predictions
   - Serve cache, update in background

### Data to Cache
- User profile and settings
- Recent predictions (last 50)
- Active market data
- Recent notifications
- Offline action queue

## 6. Push Notification Use Cases

### Immediate Notifications
- Prediction resolved (win/loss)
- New direct message
- Someone followed you
- Admin announcements

### Scheduled Notifications
- Weekly assignment reminder
- Prediction deadline approaching
- Daily market summary (opt-in)

### Smart Notifications
- Significant market movements (>20% change)
- Prediction accuracy milestones
- Leaderboard position changes

## 7. Implementation Roadmap

### Phase 1: Mobile Foundation (Week 1-2)
- [ ] Implement hamburger menu and mobile sidebar
- [ ] Add bottom navigation for mobile
- [ ] Fix touch targets (minimum 44x44px)
- [ ] Improve form inputs for mobile
- [ ] Add mobile-specific styles
- [ ] Test on various devices

### Phase 2: Basic PWA (Week 3-4)
- [ ] Create Web App Manifest
- [ ] Implement basic Service Worker
- [ ] Add install prompt UI
- [ ] Cache static assets
- [ ] Create offline fallback page
- [ ] Add app icons and splash screens

### Phase 3: Enhanced Offline (Week 5-6)
- [ ] Implement cache strategies
- [ ] Cache user data and predictions
- [ ] Add offline indicators
- [ ] Queue offline actions
- [ ] Implement sync when online

### Phase 4: Push Notifications (Week 7-8)
- [ ] Set up push notification service
- [ ] Implement subscription flow
- [ ] Create notification preferences UI
- [ ] Add notification handlers
- [ ] Test notification scenarios

### Phase 5: Advanced Features (Week 9-10)
- [ ] Background sync implementation
- [ ] Performance optimizations
- [ ] Share Target API
- [ ] Analytics and monitoring
- [ ] User feedback and iteration

## 8. Success Metrics

### Technical Metrics
- Lighthouse PWA score >90
- Time to Interactive <3s on 3G
- First Contentful Paint <1.5s
- Offline functionality works 100%

### User Metrics
- Mobile traffic increase >50%
- App install rate >20% of mobile users
- Push notification opt-in >40%
- Mobile session duration increase >30%
- Mobile prediction completion rate >80%

## 9. Testing Strategy

### Device Testing
- iOS Safari (iPhone 12+)
- Android Chrome (Pixel, Samsung)
- iPad Safari
- Android tablets

### Network Testing
- 3G connection
- Offline mode
- Flaky connection
- Background sync

### User Testing
- Navigation usability
- Touch target accuracy
- Form completion rates
- Install flow friction
- Notification preferences

## 10. Considerations & Risks

### Technical Considerations
- iOS Safari limitations for PWA
- Push notification permissions
- Service Worker complexity
- Cache storage limits
- Background sync reliability

### UX Considerations
- Install prompt timing
- Notification frequency
- Offline message clarity
- Data sync indicators
- Mobile-desktop feature parity

### Mitigation Strategies
- Progressive enhancement approach
- Feature detection and fallbacks
- Clear offline/online indicators
- User control over notifications
- Comprehensive testing plan

## Next Steps
1. Review and approve plan
2. Set up development environment
3. Create feature branches
4. Begin Phase 1 implementation
5. Set up testing infrastructure