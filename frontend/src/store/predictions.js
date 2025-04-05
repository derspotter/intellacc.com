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
    loading: van.state(false),
    error: van.state(null),
    userPredictions: van.state([])
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
      // Prevent fetch if already loading or if predictions exist
      if (this.state.loading.val || this.state.predictions.val.length > 0) {
        console.log('Skipping fetch: Already loading or predictions exist.');
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
      } catch (error) {
        console.error('Error fetching predictions:', error);
        this.state.error.val = `${error.message || 'Failed to fetch predictions'}`;
        
        // Fall back to mock data if API fails
        this.actions.loadMockPredictions.call(this);
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
          title: 'Stock Market Prediction',
          description: 'The S&P 500 will increase by at least 10% by the end of the year',
          confidence: 0.75,
          createdAt: new Date().toISOString(),
          createdBy: 'user1'
        },
        {
          id: 'mock-2',
          title: 'Technology Trend',
          description: 'Augmented reality will see mainstream consumer adoption within 18 months',
          confidence: 0.65,
          createdAt: new Date().toISOString(),
          createdBy: 'user1'
        }
      ];
    },
    
    async fetchEvents() {
      try {
        // Check authentication but don't return early - still use test events even if not logged in
        if (!isLoggedInState.val) {
          console.log('Not logged in, loading test events');
          this.actions.loadTestEvents.call(this);
          return this.state.events.val;
        }
        
        console.log('Fetching events from API');
        const events = await api.events.getAll();
        
        if (Array.isArray(events) && events.length > 0) {
          console.log('Received events from API:', events.length);
          this.state.events.val = events;
        } else {
          console.log('No events from API, using test events');
          this.actions.loadTestEvents.call(this);
        }
        
        return this.state.events.val;
      } catch (error) {
        console.error('Error fetching events:', error);
        console.log('Falling back to test events');
        this.actions.loadTestEvents.call(this);
        return this.state.events.val;
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
    
    async createPrediction(event_id, prediction_value, confidence) {
      try {
        if (!isLoggedInState.val) return null;
        
        console.log('Creating prediction:', { event_id, prediction_value, confidence });
        const prediction = await api.predictions.create(
          event_id, prediction_value, confidence
        );
        console.log('Prediction created successfully:', prediction);
        
        // State update is now handled SOLELY by the socket event handler
        // const existingIndex = this.state.predictions.val.findIndex(p => p.id === prediction.id);
        // if (existingIndex === -1) {
        //   this.state.predictions.val = [prediction, ...this.state.predictions.val];
        // }
        
        return prediction; // Return prediction so form can react
      } catch (error) {
        console.error('Error creating prediction:', error);
        throw error;
      }
    },
    
    async fetchAssignedPredictions() {
      try {
        if (!isLoggedInState.val) return [];
        
        const assigned = await api.predictions.getAssigned();
        this.state.assignedPredictions.val = Array.isArray(assigned) ? assigned : [];
        
        return this.state.assignedPredictions.val;
      } catch (error) {
        console.error('Error fetching assigned predictions:', error);
        this.state.assignedPredictions.val = [{
          id: 1,
          prediction_id: 1,
          event: "Will the price of Bitcoin exceed $100,000 by the end of 2025?",
          prediction_value: "Yes",
          assigned_at: new Date().toISOString()
        }];
        
        return this.state.assignedPredictions.val;
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