import van from "vanjs-core";
import Card from '../common/Card.js';
import Button from '../common/Button.js';
import api from '../../services/api.js';

const { div, h3, h4, p, span, small, a } = van.tags;

export default function WeeklyAssignment() {
  const assignment = van.state(null);
  const loading = van.state(true);
  const error = van.state(null);

  const loadAssignment = async () => {
    try {
      loading.val = true;
      error.val = null;
      
      const userId = localStorage.getItem('userId');
      if (!userId) {
        assignment.val = null;
        loading.val = false;
        return;
      }

      const response = await api.get(`/weekly/user/${userId}/status`);
      assignment.val = response.data;
    } catch (err) {
      console.error('Error loading weekly assignment:', err);
      error.val = err.message;
      assignment.val = null;
    } finally {
      loading.val = false;
    }
  };

  // Load assignment on component mount
  loadAssignment();

  const formatDate = (dateString) => {
    if (!dateString) return 'N/A';
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  };

  const getStatusBadge = (assignment) => {
    if (!assignment) return '';
    
    if (assignment.weekly_assignment_completed) {
      return span({
        class: 'weekly-assignment-badge completed'
      }, '✅ Completed');
    }
    
    if (assignment.has_prediction) {
      return span({
        class: 'weekly-assignment-badge in-progress'
      }, '⏳ Prediction Made');
    }
    
    return span({
      class: 'weekly-assignment-badge pending'
    }, '📋 Pending');
  };

  const getRewardInfo = (assignment) => {
    if (!assignment || !assignment.has_prediction) {
      return p({
        class: 'weekly-assignment-reward-info'
      }, [
        '💰 Make a prediction and stake at least 1/4 Kelly optimal amount to earn ',
        span({ class: 'reward-amount' }, '+50 RP'),
        ' bonus!'
      ]);
    }
    
    if (assignment.weekly_assignment_completed) {
      return p({
        class: 'weekly-assignment-reward-info completed'
      }, [
        '🎉 Congratulations! You earned the ',
        span({ class: 'reward-amount' }, '+50 RP'),
        ' weekly bonus!'
      ]);
    }
    
    return p({
      class: 'weekly-assignment-reward-info'
    }, [
      '⚠️ Prediction made but stake amount was insufficient for ',
      span({ class: 'reward-amount' }, '+50 RP'),
      ' bonus. Need ≥1/4 Kelly optimal stake.'
    ]);
  };

  return Card({
    className: 'weekly-assignment-card',
    children: [
      () => {
        if (loading.val) {
          return div({ class: 'weekly-assignment-loading' }, [
            div({ class: 'loading-spinner' }),
            p('Loading weekly assignment...')
          ]);
        }
        
        if (error.val) {
          return null;
        }
        
        if (!assignment.val) {
          return div({ class: 'weekly-assignment-empty' }, [
            h3('📅 No Weekly Assignment'),
            p('You don\'t have a weekly assignment yet. Check back on Monday for your new assignment!'),
            small('Weekly assignments are distributed every Monday at 2 AM UTC.')
          ]);
        }
        
        const assign = assignment.val;
        return div({ class: 'weekly-assignment-content' }, [
          div({ class: 'weekly-assignment-header' }, [
            h3([
              '📅 Weekly Assignment ',
              span({ class: 'week-label' }, assign.weekly_assignment_week || 'Current Week')
            ]),
            getStatusBadge(assign)
          ]),
          
          div({ class: 'weekly-assignment-body' }, [
            div({ class: 'event-info' }, [
              h4({ class: 'event-title' }, assign.event_title || 'Event Title'),
              div({ class: 'event-meta' }, [
                span({ class: 'closing-date' }, [
                  '📅 Closes: ',
                  formatDate(assign.closing_date)
                ])
              ])
            ]),
            
            div({ class: 'assignment-details' }, [
              assign.has_prediction ? 
                div({ class: 'prediction-made' }, [
                  p([
                    '✅ Your prediction: ',
                    span({ class: 'prediction-value' }, `${assign.prediction_value}%`),
                    ' confidence: ',
                    span({ class: 'confidence-value' }, `${assign.confidence}%`)
                  ])
                ]) :
                div({ class: 'no-prediction' }, [
                  p('❌ No prediction made yet'),
                  a({
                    href: `#predictions`,
                    class: 'make-prediction-link'
                  }, 'Make Prediction →')
                ])
            ]),
            
            getRewardInfo(assign),
            
            div({ class: 'weekly-assignment-actions' }, [
              Button({
                onclick: () => window.location.hash = '#predictions',
                className: 'primary',
                children: assign.has_prediction ? 'View Predictions' : 'Make Prediction'
              }),
              Button({
                onclick: loadAssignment,
                className: 'secondary',
                children: '🔄 Refresh'
              })
            ])
          ])
        ]);
      }
    ]
  });
};