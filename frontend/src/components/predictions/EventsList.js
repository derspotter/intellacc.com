import van from "vanjs-core";
import Card from '../common/Card.js';
import Button from '../common/Button.js';
import EventCard from './EventCard.js';
import api from '../../services/api.js';
import { isLoggedInState } from '../../services/auth.js';
import { registerSocketEventHandler } from '../../services/socket.js';

const { div, h2, h3, p, input, label, select, option, span, ul, li } = van.tags;

export default function EventsList() {
  const events = van.state([]);
  const loading = van.state(true);
  const error = van.state(null);
  const filter = van.state('all'); // 'all', 'open', 'closing-soon'
  const searchQuery = van.state('');
  const selectedEvent = van.state(null);
  
  // User positions state for portfolio filtering
  const userPositions = van.state([]);
  const positionsLoading = van.state(false);
  
  // Weekly assignment state
  const weeklyAssignment = van.state(null);
  const weeklyLoading = van.state(true);
  const weeklyError = van.state(null);
  
  // Cache EventCard components to prevent recreation and preserve slider state
  const eventCardCache = new Map();

  // Register Socket.IO handler for real-time market updates in event list
  const unregisterEventListSocketHandler = registerSocketEventHandler('marketUpdate', (data) => {
    console.log('📈 Market update received for EventsList:', data);
    
    // Find and update the event in the events array
    const currentEvents = events.val;
    const updatedEvents = currentEvents.map(event => {
      if (event.id === data.eventId) {
        console.log('📈 Updating event list item for event', event.id, 'new prob:', data.market_prob);
        return {
          ...event,
          market_prob: data.market_prob,
          cumulative_stake: data.cumulative_stake || event.cumulative_stake
        };
      }
      return event;
    });
    
    // Only update if something actually changed
    if (JSON.stringify(currentEvents) !== JSON.stringify(updatedEvents)) {
      events.val = updatedEvents;
      console.log('📈 EventsList events array updated');
    }
  });

  const loadEvents = async () => {
    try {
      loading.val = true;
      error.val = null;
      
      const response = await api.events.getAll();
      events.val = response || [];
    } catch (err) {
      console.error('Error loading events:', err);
      error.val = err.message;
    } finally {
      loading.val = false;
    }
  };

  const loadUserPositions = async () => {
    console.log('🔍 loadUserPositions called, isLoggedIn:', isLoggedInState.val);
    
    if (!isLoggedInState.val) {
      userPositions.val = [];
      console.log('🔍 User not logged in, clearing positions');
      return;
    }

    try {
      positionsLoading.val = true;
      const userId = localStorage.getItem('userId');
      const token = localStorage.getItem('token');
      console.log('🔍 userId:', userId, 'hasToken:', !!token);
      
      if (!userId) {
        console.log('🔍 No userId found in localStorage');
        return;
      }

      console.log('🔍 Fetching positions from:', `/api/users/${userId}/positions`);
      const response = await fetch(`/api/users/${userId}/positions`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      console.log('🔍 Positions API response status:', response.status);
      
      if (response.ok) {
        const positions = await response.json();
        userPositions.val = positions;
        console.log('🔍 Loaded user positions:', positions.length, 'positions:', positions);
      } else {
        console.error('🔍 Failed to load positions:', response.status, response.statusText);
        const errorText = await response.text();
        console.error('🔍 Error response:', errorText);
      }
    } catch (err) {
      console.error('🔍 Error loading user positions:', err);
    } finally {
      positionsLoading.val = false;
    }
  };

  const loadWeeklyAssignment = async () => {
    if (!isLoggedInState.val) {
      weeklyAssignment.val = null;
      weeklyLoading.val = false;
      return;
    }

    try {
      weeklyLoading.val = true;
      weeklyError.val = null;
      
      const userId = localStorage.getItem('userId');
      if (!userId) {
        weeklyAssignment.val = null;
        weeklyLoading.val = false;
        return;
      }

      const response = await api.get(`/weekly/user/${userId}/status`);
      const assignment = response.data;
      
      if (assignment && assignment.event_id) {
        // Find the corresponding event from our events list
        const assignedEvent = events.val.find(event => event.id === assignment.event_id);
        if (assignedEvent) {
          weeklyAssignment.val = {
            ...assignment,
            event: assignedEvent
          };
        } else {
          weeklyAssignment.val = assignment;
        }
      } else {
        weeklyAssignment.val = assignment;
      }
    } catch (err) {
      console.error('Error loading weekly assignment:', err);
      weeklyError.val = err.message;
      weeklyAssignment.val = null;
    } finally {
      weeklyLoading.val = false;
    }
  };

  const filteredEvents = () => {
    let filtered = events.val;
    
    // Apply search filter
    if (searchQuery.val.trim()) {
      const query = searchQuery.val.toLowerCase().trim();
      filtered = filtered.filter(event => 
        event.title.toLowerCase().includes(query) ||
        (event.category && event.category.toLowerCase().includes(query))
      );
    }
    
    // Apply status filter
    if (filter.val === 'open') {
      const now = new Date();
      filtered = filtered.filter(event => 
        !event.outcome && new Date(event.closing_date) > now
      );
    } else if (filter.val === 'closing-soon') {
      const now = new Date();
      const in24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      filtered = filtered.filter(event => 
        !event.outcome && 
        new Date(event.closing_date) > now && 
        new Date(event.closing_date) <= in24Hours
      );
    } else if (filter.val === 'my-positions') {
      // Filter to show only events where user has positions
      console.log('🔍 MY-POSITIONS filter selected');
      console.log('🔍 userPositions.val:', userPositions.val);
      console.log('🔍 userPositions.val.length:', userPositions.val.length);
      
      const positionEventIds = userPositions.val.map(pos => pos.event_id);
      console.log('🔍 positionEventIds:', positionEventIds);
      console.log('🔍 events.val.length before filter:', filtered.length);
      
      filtered = filtered.filter(event => {
        const hasPosition = positionEventIds.includes(event.id);
        console.log(`🔍 Event ${event.id} (${event.title}): hasPosition=${hasPosition}`);
        return hasPosition;
      });
      
      console.log('🔍 events.val.length after filter:', filtered.length);
    }
    
    // Sort by closing date (soonest first for open events)
    return filtered.sort((a, b) => {
      if (a.outcome && !b.outcome) return 1;
      if (!a.outcome && b.outcome) return -1;
      return new Date(a.closing_date) - new Date(b.closing_date);
    });
  };

  const handleEventClick = (event) => {
    selectedEvent.val = event;
  };

  const handleStakeUpdate = (result) => {
    // Refresh events list and user positions after a stake is placed
    loadEvents();
    if (isLoggedInState.val) {
      loadUserPositions();
    }
  };

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  };

  const formatProbability = (prob) => {
    return `${(parseFloat(prob) * 100).toFixed(1)}%`;
  };

  // Load events and weekly assignment on component mount
  const initializeData = async () => {
    await loadEvents();
    if (isLoggedInState.val) {
      await loadWeeklyAssignment();
      await loadUserPositions();
    }
  };
  
  initializeData();

  // Watch for filter changes and load positions when needed
  const watchFilter = () => {
    console.log('🔍 watchFilter called, filter.val:', filter.val);
    console.log('🔍 isLoggedInState.val:', isLoggedInState.val);
    console.log('🔍 userPositions.val.length:', userPositions.val.length);
    
    if (filter.val === 'my-positions' && isLoggedInState.val && userPositions.val.length === 0) {
      console.log('🔍 watchFilter: Loading user positions...');
      loadUserPositions();
    }
  };

  // Watch for filter changes directly
  van.derive(() => {
    watchFilter();
  });

  return () => div({ class: 'events-container' }, [
    
    // Events List Section
    div({ class: 'events-list-card' }, [
        div({ class: 'events-list-header' }, [
          h2('Open Questions'),
          
          // Filters and Search
          div({ class: 'events-filters' }, [
            input({
              type: 'text',
              placeholder: 'Search by title or category...',
              value: searchQuery,
              oninput: (e) => searchQuery.val = e.target.value
            }),
            
            select({
              value: filter,
              onchange: (e) => filter.val = e.target.value
            }, [
              option({ value: 'all' }, 'All Events'),
              option({ value: 'open' }, 'Open Markets'),
              option({ value: 'closing-soon' }, 'Closing Soon (24h)'),
              () => isLoggedInState.val 
                ? option({ value: 'my-positions' }, 'My Positions')
                : null
            ])
          ]),
          
          div({ class: 'events-summary' }, [
              () => loading.val ? 
                p('Loading events...') :
                p([
                  `Showing ${filteredEvents().length} of ${events.val.length} events`,
                  filteredEvents().filter(e => !e.outcome).length > 0 ? 
                    ` (${filteredEvents().filter(e => !e.outcome).length} open markets)` : ''
                ])
            ])
          ]),
        
        // Events List
        div({ class: 'events-list-content' }, [
          () => {
            if (loading.val) {
              return div({ class: 'events-loading' }, [
                div({ class: 'loading-spinner' }),
                p('Loading prediction markets...')
              ]);
            }
            
            if (error.val) {
              return div({ class: 'events-error' }, [
                h3('⚠️ Error Loading Events'),
                p(`Error: ${error.val}`),
                Button({
                  onClick: loadEvents,
                  children: 'Retry'
                })
              ]);
            }
            
            const filtered = filteredEvents();
            
            if (filtered.length === 0) {
              return div({ class: 'no-events' }, [
                h3('📭 No Events Found'),
                p(searchQuery.val.trim() ? 
                  'No events match your search criteria.' :
                  'No events available. Check back later for new prediction markets!'
                ),
                searchQuery.val.trim() ? Button({
                  onClick: () => {
                    searchQuery.val = '';
                    filter.val = 'all';
                  },
                  children: 'Clear Filters'
                }) : null
              ]);
            }
            
            // Scrollable events list
            return ul({ class: 'events-simple-list' }, 
              filtered.map(event => li({
                class: () => `event-list-item ${selectedEvent.val?.id === event.id ? 'selected' : ''} ${event.outcome ? 'resolved' : ''}`,
                onclick: () => handleEventClick(event)
              }, [
                div({ class: 'event-list-item-header' }, [
                  span({ class: 'event-title' }, event.title),
                  span({ class: 'event-prob' }, formatProbability(event.market_prob || 0.5))
                ]),
                div({ class: 'event-list-item-meta' }, [
                  span({ class: 'event-category' }, event.category || 'General'),
                  span({ class: 'event-date' }, `Closes: ${formatDate(event.closing_date)}`),
                  event.outcome ? span({ class: 'event-resolved' }, '✓ Resolved') : null
                ])
              ]))
            );
          }
        ]),

        // Refresh Button
        div({ class: 'events-actions' }, [
          Button({
            onClick: loadEvents,
            className: 'secondary',
            disabled: () => loading.val,
            children: () => loading.val ? 'Loading...' : '🔄 Refresh Markets'
          })
        ])
      ]),

    // Selected Event Card with Weekly Assignment - Always present
    div({ class: 'selected-event-container' }, [
      // Back button - only show when event is selected
      () => selectedEvent.val ? Button({
        onClick: () => selectedEvent.val = null,
        className: 'back-button secondary',
        children: '← Back to List'
      }) : null,
      
      // Event content area
      () => {
        if (!selectedEvent.val) {
          // Show weekly assigned event if available, otherwise show placeholder
          if (isLoggedInState.val && weeklyAssignment.val && weeklyAssignment.val.event) {
            const assignedEvent = weeklyAssignment.val.event;
            const cacheKey = `weekly_${assignedEvent.id}`;
            
            if (!eventCardCache.has(cacheKey)) {
              eventCardCache.set(cacheKey, EventCard({ 
                event: assignedEvent, 
                onStakeUpdate: handleStakeUpdate,
                isWeeklyAssignment: true,
                assignmentData: weeklyAssignment.val,
                hideTitle: true
              }));
            }
            
            return div({ class: 'event-card-section weekly-assignment-active' }, [
              div({ class: 'event-card-header' }, [
                h2(assignedEvent.title),
                span({ class: 'assignment-status' }, weeklyAssignment.val.weekly_assignment_completed ? '✅ Completed' : '⏳ Pending')
              ]),
              div({ class: 'weekly-assignment-subheader' }, [
                h3('📅 Your Weekly Assignment')
              ]),
              eventCardCache.get(cacheKey)
            ]);
          }
          
          // Show placeholder when no event selected and no weekly assignment
          return div({ class: 'event-card-section' }, [
            div({ class: 'event-card-header' }, [
              h2('Select an Event')
            ]),
            div({ class: 'selection-prompt' }, [
              p('Choose an event from the list above to view details, make predictions, and place bets.'),
              isLoggedInState.val && weeklyLoading.val ? p('Loading weekly assignment...') : null,
              isLoggedInState.val && !weeklyAssignment.val ? p('No weekly assignment available.') : null
            ])
          ]);
        }
        
        // Show selected event
        const cacheKey = selectedEvent.val.id;
        if (!eventCardCache.has(cacheKey)) {
          eventCardCache.set(cacheKey, EventCard({ 
            event: selectedEvent.val, 
            onStakeUpdate: handleStakeUpdate,
            hideTitle: true
          }));
        }
        
        return div({ class: 'event-card-section' }, [
          h2(selectedEvent.val.title),
          eventCardCache.get(cacheKey)
        ]);
      }
    ])
  ]);
};