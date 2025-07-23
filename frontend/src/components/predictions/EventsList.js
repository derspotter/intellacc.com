import van from "vanjs-core";
import Card from '../common/Card.js';
import Button from '../common/Button.js';
import EventCard from './EventCard.js';
import api from '../../services/api.js';

const { div, h2, h3, p, input, label, select, option } = van.tags;

export default function EventsList() {
  const events = van.state([]);
  const loading = van.state(true);
  const error = van.state(null);
  const filter = van.state('all'); // 'all', 'open', 'closing-soon'
  const searchQuery = van.state('');

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
    }
    
    // Sort by closing date (soonest first for open events)
    return filtered.sort((a, b) => {
      if (a.outcome && !b.outcome) return 1;
      if (!a.outcome && b.outcome) return -1;
      return new Date(a.closing_date) - new Date(b.closing_date);
    });
  };

  const handleStakeUpdate = (result) => {
    // Refresh events list after a stake is placed
    loadEvents();
  };

  // Load events on component mount
  loadEvents();

  return () => Card({
    className: 'events-list-card',
    children: [
      div({ class: 'events-list-header' }, [
        h2('📈 Prediction Markets'),
        
        // Filters and Search
        div({ class: 'events-filters' }, [
          div({ class: 'filter-row' }, [
            div({ class: 'search-box' }, [
              label('Search Events:'),
              input({
                type: 'text',
                placeholder: 'Search by title or category...',
                value: searchQuery,
                oninput: (e) => searchQuery.val = e.target.value
              })
            ]),
            
            div({ class: 'filter-select' }, [
              label('Filter:'),
              select({
                value: filter,
                onchange: (e) => filter.val = e.target.value
              }, [
                option({ value: 'all' }, 'All Events'),
                option({ value: 'open' }, 'Open Markets'),
                option({ value: 'closing-soon' }, 'Closing Soon (24h)')
              ])
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
          
          return div({ class: 'events-grid' }, 
            filtered.map(event => EventCard({ 
              event, 
              onStakeUpdate: handleStakeUpdate 
            }))
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
    ]
  });
};