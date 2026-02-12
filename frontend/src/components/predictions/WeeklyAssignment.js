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
    
    if (assignment.has_stake) {
      return span({
        class: 'weekly-assignment-badge in-progress'
      }, '⏳ Stake Placed');
    }
    
    return span({
      class: 'weekly-assignment-badge pending'
    }, '📋 Pending');
  };

  const getParticipationInfo = (assignment) => {
    const minStake = Number(assignment?.min_stake_rp ?? 0);
    if (!assignment) return null;

    if (assignment.weekly_assignment_completed) {
      return p({
        class: 'weekly-assignment-reward-info completed'
      }, '✅ Weekly requirement met.');
    }

    if (!assignment.has_stake) {
      return p({
        class: 'weekly-assignment-reward-info'
      }, `⚠️ Place at least ${minStake.toFixed(2)} RP this week to avoid the 1% missed-week penalty.`);
    }

    const currentStake = Number(assignment.stake_amount || 0);
    if (currentStake >= minStake) {
      return p({
        class: 'weekly-assignment-reward-info completed'
      }, `✅ Current stake (${currentStake.toFixed(2)} RP) meets this week's requirement.`);
    }

    return p({
      class: 'weekly-assignment-reward-info'
    }, `⚠️ Current stake (${currentStake.toFixed(2)} RP) is below ${minStake.toFixed(2)} RP. Add stake to avoid the 1% missed-week penalty.`);
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
              assign.has_stake ? 
                div({ class: 'prediction-made' }, [
                  p([
                    '✅ Stake this week: ',
                    span({ class: 'prediction-value' }, `${Number(assign.stake_amount || 0).toFixed(2)} RP`)
                  ])
                ]) :
                div({ class: 'no-prediction' }, [
                  p('❌ No stake placed yet'),
                  a({
                    href: `#predictions`,
                    class: 'make-prediction-link'
                  }, 'Place Stake →')
                ])
            ]),
            
            getParticipationInfo(assign),
            
            div({ class: 'weekly-assignment-actions' }, [
              Button({
                onclick: () => window.location.hash = '#predictions',
                className: 'primary',
                children: assign.has_stake ? 'View Market' : 'Place Stake'
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
