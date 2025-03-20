import van from 'vanjs-core';
import api from '../services/api';
import auth from '../services/auth';

const predictionsStore = {
  state: {
    predictions: van.state([]),
    assignedPredictions: van.state([]),
    events: van.state([]),
    bettingStats: van.state({ completed_bets: 0, total_assigned: 0, remaining_bets: 5 }),
    loading: van.state(false),
    error: van.state(null)
  },
  
  actions: {
    async fetchPredictions() {
      try {
        if (!auth.isLoggedInState.val) return [];
        
        this.state.loading.val = true;
        
        const predictions = await api.predictions.getAll();
        this.state.predictions.val = Array.isArray(predictions) ? predictions : [];
        
        return this.state.predictions.val;
      } catch (error) {
        console.error('Error fetching predictions:', error);
        this.actions.loadMockPredictions();
        return [];
      } finally {
        this.state.loading.val = false;
      }
    },
    
    loadMockPredictions() {
      this.state.predictions.val = [
        {
          id: 1,
          event: "Will the price of Bitcoin exceed $100,000 by the end of 2025?",
          prediction_value: "Yes",
          confidence: 80,
          created_at: new Date().toISOString(),
          outcome: null
        },
        {
          id: 2,
          event: "Will AI systems achieve human-level reasoning by 2030?",
          prediction_value: "No",
          confidence: 65,
          created_at: new Date(Date.now() - 86400000).toISOString(),
          outcome: null
        }
      ];
    },
    
    async fetchEvents() {
      try {
        if (!auth.isLoggedInState.val) return [];
        
        const events = await api.events.getAll();
        this.state.events.val = Array.isArray(events) ? events : [];
        
        if (this.state.events.val.length === 0) {
          this.actions.loadTestEvents();
        }
        
        return this.state.events.val;
      } catch (error) {
        console.error('Error fetching events:', error);
        this.actions.loadTestEvents();
        return this.state.events.val;
      }
    },
    
    loadTestEvents() {
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
        }
      ];
    },
    
    async createPrediction(event_id, prediction_value, confidence) {
      try {
        if (!auth.isLoggedInState.val) return null;
        
        const prediction = await api.predictions.create(
          event_id, prediction_value, confidence
        );
        
        this.state.predictions.val = [prediction, ...this.state.predictions.val];
        
        return prediction;
      } catch (error) {
        console.error('Error creating prediction:', error);
        throw error;
      }
    },
    
    async fetchAssignedPredictions() {
      try {
        if (!auth.isLoggedInState.val) return [];
        
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
        if (!auth.isLoggedInState.val) return null;
        
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
        if (!auth.isLoggedInState.val) return null;
        
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
        if (!auth.isLoggedInState.val) return null;
        
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
        if (!auth.isLoggedInState.val) return null;
        
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
    }
  }
};

export default predictionsStore;