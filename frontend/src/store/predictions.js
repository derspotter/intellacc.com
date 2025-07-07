import van from 'vanjs-core';
import api from '../services/api';
import { getTokenData, isLoggedInState } from '../services/auth';
import { registerSocketEventHandler } from '../services/socket';

const predictionsStore = {
  state: {
    predictions: van.state([]),
    assignedPredictions: van.state([]),
    events: van.state([]),
    bettingStats: van.state({ completed_bets: 0, total_assigned: 0, remaining_bets: 5 }),
    loading: van.state(false), // Restored generic loading state
    loadingEvents: van.state(false), // Added specific loading state for events
    loadingAssigned: van.state(false), // Added specific loading state for assigned predictions
    error: van.state(null),
    userPredictions: van.state([]),
    initialFetchDone: van.state(false) // Flag to track if initial fetch has been attempted
  },
  
  init() {
    // Register socket event handler for new predictions
    registerSocketEventHandler('newPrediction', (prediction) => {
      // Only update if the prediction belongs to the current user
      const userData = getTokenData();
      if (userData && prediction.user_id === userData.id) {
        console.log('Received new prediction via socket:', prediction);
        
        // Check if prediction already exists to avoid duplicates
        const existingIndex = this.state.predictions.val.findIndex(p => p.id === prediction.id);
        if (existingIndex === -1) {
          // Not a duplicate, add it to the list
          this.state.predictions.val = [prediction, ...this.state.predictions.val];
        }
      }
    });
    
    return this;
  },
  
  actions: {
    async fetchPredictions() {
      if (this.state.loading.val) {
        console.log('Skipping fetchPredictions: Already loading.');
        return;
      }
      // If initial fetch is marked done and predictions exist, no need to fetch again.
      if (this.state.initialFetchDone.val && this.state.predictions.val.length > 0) {
        console.log('Skipping fetchPredictions: Initial fetch completed and predictions exist.');
        return;
      }
      // If predictions somehow exist (e.g. from cache/SSR) but initialFetchDone is false,
      // mark it as done and skip fetching to avoid overwriting potentially newer cache.
      if (this.state.predictions.val.length > 0 && !this.state.initialFetchDone.val) {
        console.log('Skipping fetchPredictions: Predictions exist, marking initialFetchDone as true.');
        this.state.initialFetchDone.val = true;
        return;
      }
      
      this.state.loading.val = true;
      this.state.error.val = '';
      
      try {
        // Try to use the real API regardless of environment
        if (!api || !api.predictions) {
          throw new Error('API not available');
        }
        
        console.log('Fetching predictions from API...');
        const predictions = await api.predictions.getAll();
        console.log('Received predictions from API:', predictions);
        this.state.predictions.val = predictions;
        this.state.initialFetchDone.val = true; // Mark initial fetch as attempted/completed
      } catch (error) {
        console.error('Error fetching predictions:', error);
        this.state.error.val = `${error.message || 'Failed to fetch predictions'}`;
        
        // Fall back to mock data if API fails
        this.actions.loadMockPredictions.call(this);
        this.state.initialFetchDone.val = true; // Mark initial fetch as attempted/completed even if fallback
      } finally {
        this.state.loading.val = false;
      }
    },
    
    loadMockPredictions() {
      // Ensure we have access to state
      if (!this || !this.state) {
        console.error('Invalid context in loadMockPredictions');
        return;
      }
      
      this.state.predictions.val = [
        {
          id: 'mock-1',
          event: 'Will the S&P 500 increase by at least 10% by the end of 2024?',
          title: 'Stock Market Prediction',
          description: 'The S&P 500 will increase by at least 10% by the end of the year',
          prediction_value: 'Yes',
          confidence: 75,
          outcome: 'correct',
          created_at: new Date().toISOString(),
          createdBy: 'user1'
        },
        {
          id: 'mock-2',
          event: 'Will AR see mainstream consumer adoption within 18 months?',
          title: 'Technology Trend',
          description: 'Augmented reality will see mainstream consumer adoption within 18 months',
          prediction_value: 'No',
          confidence: 65,
          outcome: null,
          created_at: new Date().toISOString(),
          createdBy: 'user1'
        },
        {
          id: 'mock-3',
          event: 'Will Bitcoin exceed $100,000 by end of 2024?',
          title: 'Crypto Prediction',
          description: 'Bitcoin price prediction for end of year',
          prediction_value: 'Yes',
          confidence: 80,
          outcome: 'incorrect',
          created_at: new Date().toISOString(),
          createdBy: 'user1'
        }
      ];
    },
    
    async fetchEvents(search = '') {
      // Prevent fetch if already loading
      if (this.state.loadingEvents.val) {
        console.log('Skipping fetchEvents: Already loading.');
        return;
      }
      this.state.loadingEvents.val = true;
      this.state.error.val = null; // Reset error specific to this fetch if needed

      try {
        // Always try API first, even if not logged in (but it will fail gracefully)
        console.log('Fetching events from API with search:', search);
        const events = await api.events.getAll(search);
        
        if (Array.isArray(events) && events.length >= 0) {
          console.log('Received events from API:', events.length);
          this.state.events.val = events;
        } else {
          console.log('No events from API, using empty array');
          this.state.events.val = [];
        }
        
        return this.state.events.val;
      } catch (error) {
        console.error('Error fetching events:', error);
        
        console.log('API error, setting empty events array');
        this.state.events.val = [];
        this.state.error.val = error.message || 'Failed to fetch events';
        
        return this.state.events.val;
      } finally {
        this.state.loadingEvents.val = false;
      }
    },
    
    loadTestEvents() {
      // Make sure 'this' and 'this.state' exist
      if (!this || !this.state || !this.state.events) {
        console.error('Invalid context in loadTestEvents');
        return;
      }
      
      console.log('Loading test events');
      
      // Set test events directly
      this.state.events.val = [
        {
          id: 1,
          title: "Will the price of Bitcoin exceed $100,000 by the end of 2025?",
          closing_date: new Date(2025, 11, 31).toISOString()
        },
        {
          id: 2,
          title: "Will AI systems achieve human-level reasoning by 2030?",
          closing_date: new Date(2030, 0, 1).toISOString()
        },
        {
          id: 3,
          title: "Will remote work remain above 30% of total workforce by 2026?",
          closing_date: new Date(2026, 0, 1).toISOString()
        }
      ];
      
      console.log('Test events loaded:', this.state.events.val);
    },
    
    async createPrediction(event_id, prediction_value, confidence, prediction_type = 'binary', numerical_value = null, lower_bound = null, upper_bound = null, prob_vector = null) {
      try {
        if (!isLoggedInState.val) return null;
        
        console.log('Creating prediction:', { 
          event_id, 
          prediction_value, 
          confidence, 
          prediction_type, 
          numerical_value, 
          lower_bound, 
          upper_bound,
          prob_vector
        });
        
        const prediction = await api.predictions.create(
          event_id, prediction_value, confidence, prediction_type, numerical_value, lower_bound, upper_bound, prob_vector
        );
        console.log('Prediction created successfully:', prediction);
        
        return prediction; // Return prediction so form can react
      } catch (error) {
        console.error('Error creating prediction:', error);
        throw error;
      }
    },
    
    async fetchAssignedPredictions() {
       // Prevent fetch if already loading
      if (this.state.loadingAssigned.val) {
        console.log('Skipping fetchAssignedPredictions: Already loading.');
        return;
      }
      this.state.loadingAssigned.val = true;
      this.state.error.val = null; // Reset error

      try {
        if (!isLoggedInState.val) {
           this.state.loadingAssigned.val = false; // Reset loading if not logged in
           return [];
        }

        const assigned = await api.predictions.getAssigned();
        this.state.assignedPredictions.val = Array.isArray(assigned) ? assigned : [];
        
        return this.state.assignedPredictions.val;
      } catch (error) {
        console.error('Error fetching assigned predictions:', error);
        this.state.error.val = error.message || 'Failed to fetch assigned predictions';
        // Consider if fallback is still needed or just show error
        this.state.assignedPredictions.val = [{
          id: 1,
          prediction_id: 1,
          event: "Fallback: Will Bitcoin exceed $100,000 by the end of 2025?",
          prediction_value: "Yes",
          assigned_at: new Date().toISOString(),
          event_id: 1 // Add fallback event_id if needed
        }];
        return this.state.assignedPredictions.val;
      } finally {
         this.state.loadingAssigned.val = false; // Ensure loading state is reset
      }
    },
    
    async fetchBettingStats() {
      try {
        if (!isLoggedInState.val) return null;
        
        const stats = await api.predictions.getBettingStats();
        this.state.bettingStats.val = stats;
        
        return stats;
      } catch (error) {
        console.error('Error fetching betting stats:', error);
        this.state.bettingStats.val = { 
          completed_bets: 0, 
          total_assigned: 0, 
          remaining_bets: 5
        };
        
        return this.state.bettingStats.val;
      }
    },
    
    async createEvent(title, details, closingDate) {
      try {
        if (!isLoggedInState.val) return null;
        
        const event = await api.events.create({
          title,
          details,
          closing_date: closingDate
        });
        
        this.state.events.val = [event, ...this.state.events.val];
        return event;
      } catch (error) {
        console.error('Error creating event:', error);
        throw error;
      }
    },
    
    async resolveEvent(eventId, outcome) {
      try {
        if (!isLoggedInState.val) return null;
        
        const result = await api.events.resolve(eventId, outcome);
        
        this.state.events.val = this.state.events.val.map(event => 
          event.id === eventId ? {...event, outcome} : event
        );
        
        return result;
      } catch (error) {
        console.error('Error resolving event:', error);
        throw error;
      }
    },
    
    async placeBet(assignmentId, confidenceLevel, betOn) {
      try {
        if (!isLoggedInState.val) return null;
        
        const result = await api.predictions.placeBet(
          assignmentId, confidenceLevel, betOn
        );
        
        await this.actions.fetchAssignedPredictions();
        await this.actions.fetchBettingStats();
        
        return result;
      } catch (error) {
        console.error('Error placing bet:', error);
        throw error;
      }
    },
    
    async fetchUserPredictions(userId) {
      this.state.loading.val = true;
      this.state.error.val = '';
      
      try {
        // Check if in development mode
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
          this.state.userPredictions.val = this.state.predictions.val;
          return;
        }
        
        // Production mode - try API
        if (!api || !api.predictions) {
          throw new Error('API not available');
        }
        
        const userPredictions = await api.predictions.getByUser(userId);
        this.state.userPredictions.val = userPredictions;
      } catch (error) {
        console.error('Error fetching user predictions:', error);
        this.state.error.val = `${error.message || 'Failed to fetch user predictions'}`;
        
        // Fall back to mock data
        this.state.userPredictions.val = this.state.predictions.val.slice(0, 2);
      } finally {
        this.state.loading.val = false;
      }
    }
  }
};

export default predictionsStore.init();