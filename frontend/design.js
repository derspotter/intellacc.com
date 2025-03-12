import van from './van-1.5.3.min.js';
const { div, header, main, section, h1, h2, h3, ul, li, a, p, span, button, form, input, label, select, option, textarea, table, tr, th, td } = van.tags;

// CSS moved to external styles.css file

// Build the header component
const headerElem = header({ class: "header-box" },
  div({ class: "header-content" }, [
    div({ class: "header-item title" },
      a({
        href: "#home",
        style: "text-decoration: none; color: inherit;",
        onclick: () => { window.location.hash = 'home'; }
      }, "INTELLACC")
    ),
    div({ class: "header-item" }, ["Version", div({}, "v0.1.5")]),
    div({ class: "header-item" }, ["License", div({}, "MIT")]),
    div({ class: "subtitle" }, "A social network with prediction markets")
  ])
);

// Create reactive state for posts and auth
const postsState = van.state([]);
const loadingState = van.state(true);
const errorState = van.state(null);
const isLoggedInState = van.state(false);
const tokenState = van.state(localStorage.getItem('token') || '');
const currentPage = van.state(window.location.hash.slice(1) || 'home');
const loginError = van.state('');
const viewReady = van.state(false);

// Predictions states
const predictionsState = van.state([]);
const predictionsLoadingState = van.state(false);
const eventsState = van.state([]);
const assignedPredictionsState = van.state([]);
const bettingStatsState = van.state({ completed_bets: 0, total_assigned: 0, remaining_bets: 5 });

// Profile states
const userProfileState = van.state(null);
const userPredictionsState = van.state([]);
const followersState = van.state([]);
const followingState = van.state([]);

// Only log in development
if (process.env.NODE_ENV !== 'production') {
  console.log('Initial page state:', currentPage.val);
}

// Check if user is logged in
const checkAuth = () => {
  const token = localStorage.getItem('token');
  if (token) {
    tokenState.val = token;
    isLoggedInState.val = true;
    return true;
  }
  isLoggedInState.val = false;
  return false;
};

/**
 * Fetch posts from the API or load mock data if necessary
 */
const fetchPosts = async () => {
  try {
    loadingState.val = true;
    errorState.val = null;

    // All post endpoints require authentication, so only try if logged in
    if (!isLoggedInState.val) {
      // If not logged in, just load mock data
      loadMockPosts();
      return;
    }

    const response = await fetch('/api/posts', {
      headers: {
        'Authorization': `Bearer ${tokenState.val}`,
        'Cache-Control': 'no-cache' // Ensure fresh content
      }
    });

    if (!response.ok) {
      if (response.status === 401) {
        // Handle unauthorized - clear token and update state
        localStorage.removeItem('token');
        tokenState.val = '';
        isLoggedInState.val = false;
        throw new Error('Session expired. Please log in again.');
      }
      throw new Error(`Failed to fetch posts: ${response.statusText || 'Server error'}`);
    }

    const data = await response.json();

    // Handle different API response formats gracefully
    postsState.val = Array.isArray(data)
      ? data
      : (data.posts ? data.posts : []);

    // Store last fetch time for potential caching strategies
    localStorage.setItem('last_posts_fetch', Date.now().toString());
  } catch (error) {
    console.error('Error fetching posts:', error);
    errorState.val = error.message;

    // Load mock data if in development or network error
    if (
      error.name === 'TypeError' || // Network error
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1'
    ) {
      loadMockPosts();
    }
  } finally {
    loadingState.val = false;
  }
};

// Mock posts for development if API is unavailable
const loadMockPosts = () => {
  postsState.val = [
    {
      id: 1,
      title: "First Post",
      content: "This is the first post content. It appears the API might not be connected yet.",
      username: "user1",
      created_at: new Date().toISOString()
    },
    {
      id: 2,
      title: "Second Post",
      content: "This is the second post with more detailed content. This is a mock post since the API connection isn't working.",
      username: "user2",
      created_at: new Date(Date.now() - 86400000).toISOString()
    }
  ];
  loadingState.val = false;
};

// Generate post links for table of contents
const PostLinks = () => {
  return postsState.val.map((post, index) =>
    li(a({ href: `#post-${post.id}` }, `${index + 1}. ${post.title || 'Post #' + post.id}`))
  );
};

// Build the contents component with dynamic posts
const ContentsElem = () => div({ class: "contents" }, [
  h2("POSTS"),
  loadingState.val
    ? p({ class: "loading" }, "Loading posts...")
    : errorState.val
      ? p("Error loading posts: " + errorState.val)
      : postsState.val.length === 0
        ? p("No posts available.")
        : ul(PostLinks())
]);

// Build the posts section with content from the API
const PostsSection = () => {
  if (loadingState.val) {
    return section(p({ class: "loading" }, "Loading posts..."));
  }

  if (errorState.val) {
    return section([
      div({ class: "error" }, errorState.val),
      button({ onclick: () => { fetchPosts(); } }, "Try Again"),
      button({ onclick: () => { loadMockPosts(); } }, "Load Mock Data")
    ]);
  }

  if (postsState.val.length === 0) {
    return section(p("No posts available."));
  }

  return section(
    postsState.val.map(post =>
      div({ class: "post", id: `post-${post.id}` }, [
        h2({ class: "post-title" }, post.title || `Post #${post.id}`),
        div({ class: "post-meta" }, [
          span(`Posted by: ${post.username || 'Anonymous'}`),
          span(` • ${new Date(post.created_at).toLocaleDateString()}`)
        ]),
        p(post.content)
      ])
    )
  );
};

// Update page when hash changes
const updatePageFromHash = () => {
  currentPage.val = window.location.hash.slice(1) || 'home';
  
  // Clear login errors when navigating to login page
  if (currentPage.val === 'login') {
    loginError.val = '';
  }
};

// Make function available globally
window.updatePageFromHash = updatePageFromHash;

window.addEventListener('hashchange', updatePageFromHash);

// Fetch predictions
const fetchPredictions = async () => {
  if (!isLoggedInState.val) return;
  
  try {
    predictionsLoadingState.val = true;
    
    const response = await fetch('/api/predictions', {
      headers: {
        'Authorization': `Bearer ${tokenState.val}`,
        'Cache-Control': 'no-cache'
      }
    });
    
    if (!response.ok) {
      if (response.status === 401) {
        localStorage.removeItem('token');
        tokenState.val = '';
        isLoggedInState.val = false;
        throw new Error('Session expired. Please log in again.');
      }
      throw new Error(`Failed to fetch predictions: ${response.statusText || 'Server error'}`);
    }
    
    const data = await response.json();
    predictionsState.val = Array.isArray(data) ? data : [];
  } catch (error) {
    console.error('Error fetching predictions:', error);
    // Load mock data if in development
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      loadMockPredictions();
    }
  } finally {
    predictionsLoadingState.val = false;
  }
};

// Fetch assigned predictions
const fetchAssignedPredictions = async () => {
  if (!isLoggedInState.val) return;
  
  try {
    const response = await fetch('/api/predictions/assigned', {
      headers: {
        'Authorization': `Bearer ${tokenState.val}`,
        'Cache-Control': 'no-cache'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch assigned predictions: ${response.statusText || 'Server error'}`);
    }
    
    const data = await response.json();
    assignedPredictionsState.val = Array.isArray(data) ? data : [];
  } catch (error) {
    console.error('Error fetching assigned predictions:', error);
    // Load mock data if in development
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      assignedPredictionsState.val = [{
        id: 1,
        prediction_id: 1,
        event: "Will the price of Bitcoin exceed $100,000 by the end of 2025?",
        prediction_value: "Yes",
        assigned_at: new Date().toISOString()
      }];
    }
  }
};

// Fetch betting stats
const fetchBettingStats = async () => {
  if (!isLoggedInState.val) return;
  
  try {
    const response = await fetch('/api/bets/stats', {
      headers: {
        'Authorization': `Bearer ${tokenState.val}`,
        'Cache-Control': 'no-cache'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch betting stats: ${response.statusText || 'Server error'}`);
    }
    
    const data = await response.json();
    bettingStatsState.val = data;
  } catch (error) {
    console.error('Error fetching betting stats:', error);
    // Default stats
    bettingStatsState.val = { 
      completed_bets: 0, 
      total_assigned: 0, 
      remaining_bets: 5
    };
  }
};

// Fetch events
const fetchEvents = async () => {
  if (!isLoggedInState.val) return;
  
  try {
    const response = await fetch('/api/events', {
      headers: {
        'Authorization': `Bearer ${tokenState.val}`,
        'Cache-Control': 'no-cache'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch events: ${response.statusText || 'Server error'}`);
    }
    
    const data = await response.json();
    eventsState.val = Array.isArray(data) ? data : [];
  } catch (error) {
    console.error('Error fetching events:', error);
    // Mock events for development
    eventsState.val = [{
      id: 1,
      title: "Will the price of Bitcoin exceed $100,000 by the end of 2025?",
      closing_date: new Date(2025, 11, 31).toISOString()
    }];
  }
};

// Create a prediction
const createPrediction = async (event_id, prediction_value, confidence) => {
  if (!isLoggedInState.val) return null;
  
  try {
    const response = await fetch('/api/predict', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokenState.val}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ event_id, prediction_value, confidence })
    });
    
    if (!response.ok) {
      throw new Error(`Failed to create prediction: ${response.statusText || 'Server error'}`);
    }
    
    const data = await response.json();
    // Add new prediction to the state
    predictionsState.val = [data, ...predictionsState.val];
    return data;
  } catch (error) {
    console.error('Error creating prediction:', error);
    return null;
  }
};

// Place a bet
const placeBet = async (assignmentId, confidenceLevel, betOn) => {
  if (!isLoggedInState.val) return null;
  
  try {
    const response = await fetch(`/api/assignments/${assignmentId}/bet`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokenState.val}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ confidenceLevel, betOn })
    });
    
    if (!response.ok) {
      throw new Error(`Failed to place bet: ${response.statusText || 'Server error'}`);
    }
    
    const data = await response.json();
    // Refresh assigned predictions and stats
    fetchAssignedPredictions();
    fetchBettingStats();
    return data;
  } catch (error) {
    console.error('Error placing bet:', error);
    return null;
  }
};

// Fetch user profile
const fetchUserProfile = async () => {
  if (!isLoggedInState.val) return;
  
  try {
    const response = await fetch('/api/me', {
      headers: {
        'Authorization': `Bearer ${tokenState.val}`,
        'Cache-Control': 'no-cache'
      }
    });
    
    if (!response.ok) {
      if (response.status === 401) {
        localStorage.removeItem('token');
        tokenState.val = '';
        isLoggedInState.val = false;
        throw new Error('Session expired. Please log in again.');
      }
      throw new Error(`Failed to fetch profile: ${response.statusText || 'Server error'}`);
    }
    
    const data = await response.json();
    userProfileState.val = data;
  } catch (error) {
    console.error('Error fetching profile:', error);
    // Mock profile for development
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      userProfileState.val = {
        id: 1,
        username: 'testuser',
        email: 'test@example.com',
        bio: 'This is a test user profile'
      };
    }
  }
};

// Update user profile
const updateUserProfile = async (bio) => {
  if (!isLoggedInState.val) return null;
  
  try {
    const response = await fetch('/api/users/profile', {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${tokenState.val}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ bio })
    });
    
    if (!response.ok) {
      throw new Error(`Failed to update profile: ${response.statusText || 'Server error'}`);
    }
    
    const data = await response.json();
    userProfileState.val = data;
    return data;
  } catch (error) {
    console.error('Error updating profile:', error);
    return null;
  }
};

// Fetch followers
const fetchFollowers = async () => {
  if (!isLoggedInState.val || !userProfileState.val) return;
  
  try {
    const userId = userProfileState.val.id;
    const response = await fetch(`/api/users/${userId}/followers`, {
      headers: {
        'Authorization': `Bearer ${tokenState.val}`,
        'Cache-Control': 'no-cache'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch followers: ${response.statusText || 'Server error'}`);
    }
    
    const data = await response.json();
    followersState.val = Array.isArray(data) ? data : [];
  } catch (error) {
    console.error('Error fetching followers:', error);
    followersState.val = []; // Empty array on error
  }
};

// Fetch following
const fetchFollowing = async () => {
  if (!isLoggedInState.val || !userProfileState.val) return;
  
  try {
    const userId = userProfileState.val.id;
    const response = await fetch(`/api/users/${userId}/following`, {
      headers: {
        'Authorization': `Bearer ${tokenState.val}`,
        'Cache-Control': 'no-cache'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch following: ${response.statusText || 'Server error'}`);
    }
    
    const data = await response.json();
    followingState.val = Array.isArray(data) ? data : [];
  } catch (error) {
    console.error('Error fetching following:', error);
    followingState.val = []; // Empty array on error
  }
};

// Mock predictions for development
const loadMockPredictions = () => {
  predictionsState.val = [
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
};

// Initial call to set the current page based on hash
updatePageFromHash();

// Login function
const login = async (email, password) => {
  try {
    loginError.val = '';
    
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(error || 'Login failed');
    }

    const data = await response.json();

    // Store the token in localStorage
    localStorage.setItem('token', data.token);
    tokenState.val = data.token;
    isLoggedInState.val = true;
    
    // Navigate to home page
    window.location.hash = 'home';
    
    // Fetch posts after login
    fetchPosts();
    
  } catch (error) {
    // Log error in development
    if (process.env.NODE_ENV !== 'production') {
      console.error('Login error:', error);
    }

    // Provide a more user-friendly error message for network errors
    if (error.name === 'TypeError' && error.message.includes('fetch')) {
      loginError.val = 'Network error. Please check your connection or contact administrator.';
    } else {
      loginError.val = error.message;
    }
  }
};

// Logout function
const logout = () => {
  // Clear token and update auth state
  localStorage.removeItem('token');
  tokenState.val = '';
  isLoggedInState.val = false;
  
  // Navigate to login page
  window.location.hash = 'login';
  
  // Load mock posts after logout
  loadMockPosts();
};

// Login form component
const LoginForm = () =>
  div({ class: "login-container" }, [
    h2("Login to Intellacc"),
    () => loginError.val ? div({ class: "error-message" }, loginError.val) : null,
    form({
      onsubmit: (e) => {
        e.preventDefault();
        const email = e.target.elements.email.value;
        const password = e.target.elements.password.value;
        login(email, password);
      },
      class: "login-form"
    }, [
      div({ class: "form-group" }, [
        label({ for: "email" }, "Email:"),
        input({ type: "email", id: "email", name: "email", required: true })
      ]),
      div({ class: "form-group" }, [
        label({ for: "password" }, "Password:"),
        input({ type: "password", id: "password", name: "password", required: true })
      ]),
      button({ type: "submit", class: "login-button" }, "Log In")
    ]),
    div([
      p("Don't have an account yet?"),
      p("Please contact an administrator to create an account for you.")
    ])
  ]);

// Login notice component
const LoginNotice = () => {
  // Don't show the notice during transitions or if logged in
  if (isLoggedInState.val || currentPage.val === 'login') return null;

  return div({ class: "login-notice" }, [
    p("You are viewing public posts. Log in to see personalized content."),
    button({
      onclick: () => {
        window.location.hash = 'login';
      }
    }, "Log In")
  ]);
};

// Nav component with optional logout button
const Nav = () =>
  div({ class: "nav" }, [
    isLoggedInState.val ? [
      button({ onclick: logout }, "Logout")
    ] : null
  ]);

// Sidebar component with navigation links
const Sidebar = () =>
  div({ class: "sidebar" }, [
    div({ class: "sidebar-logo" }, "INTELLACC"),
    div({ class: "sidebar-content" }, [
      div({ class: "sidebar-item" }, a({ href: "#home" }, "Home")),
      div({ class: "sidebar-item" }, a({ href: "#posts" }, "All Posts")),
      div({ class: "sidebar-item" }, a({ href: "#predictions" }, "Predictions")),
      div({ class: "sidebar-item" }, a({ href: "#popular" }, "Popular")),
      isLoggedInState.val ? [
        div({ class: "sidebar-item" }, a({ href: "#profile" }, "My Profile")),
        div({ class: "sidebar-item" }, button({ onclick: logout }, "Logout"))
      ] : [
        div({ class: "sidebar-item" }, a({ href: "#login" }, "Login"))
      ]
    ])
  ]);

// Create a custom login page component
const LoginPage = () => {
  const loginContent = LoginForm();
  return main({ class: "main-content" }, loginContent);
};

// Create a Predictions page component
const PredictionsPage = () => {
  // Fetch data when the page is loaded
  setTimeout(() => {
    if (isLoggedInState.val) {
      fetchPredictions();
      fetchEvents();
      fetchAssignedPredictions();
      fetchBettingStats();
    }
  }, 10);
  
  // Create a new prediction form
  const NewPredictionForm = () => {
    const formState = van.state({
      eventId: '',
      prediction: '',
      confidence: 50,
      submitting: false,
      error: '',
      success: ''
    });
    
    return div({ class: "card prediction-form" }, [
      h2("Make a New Prediction"),
      
      () => formState.val.error ? div({ class: "error-message" }, formState.val.error) : null,
      () => formState.val.success ? div({ class: "success-message" }, formState.val.success) : null,
      
      form({
        onsubmit: async (e) => {
          e.preventDefault();
          formState.val = {...formState.val, submitting: true, error: '', success: ''};
          
          try {
            const result = await createPrediction(
              formState.val.eventId,
              formState.val.prediction,
              formState.val.confidence
            );
            
            if (result) {
              formState.val = {
                eventId: '',
                prediction: '',
                confidence: 50,
                submitting: false,
                error: '',
                success: 'Prediction created successfully!'
              };
              // Clear success message after 3 seconds
              setTimeout(() => {
                formState.val = {...formState.val, success: ''};
              }, 3000);
            } else {
              formState.val = {...formState.val, submitting: false, error: 'Failed to create prediction'};
            }
          } catch (error) {
            formState.val = {...formState.val, submitting: false, error: error.message};
          }
        }
      }, [
        div({ class: "form-group" }, [
          label({ for: "event" }, "Select Event:"),
          select({
            id: "event",
            required: true,
            disabled: formState.val.submitting,
            value: formState.val.eventId,
            onchange: (e) => {
              formState.val = {...formState.val, eventId: e.target.value};
            }
          }, [
            option({ value: "" }, "-- Select an event --"),
            () => eventsState.val.map(event => 
              option({ value: event.id }, event.title)
            )
          ])
        ]),
        div({ class: "form-group" }, [
          label({ for: "prediction" }, "Your Prediction:"),
          input({
            type: "text",
            id: "prediction",
            required: true,
            disabled: formState.val.submitting,
            value: formState.val.prediction,
            placeholder: "e.g., Yes, No, or specific prediction",
            onchange: (e) => {
              formState.val = {...formState.val, prediction: e.target.value};
            }
          })
        ]),
        div({ class: "form-group" }, [
          label({ for: "confidence" }, `Confidence: ${formState.val.confidence}%`),
          input({
            type: "range",
            id: "confidence",
            min: "1",
            max: "100",
            step: "1",
            disabled: formState.val.submitting,
            value: formState.val.confidence,
            onchange: (e) => {
              formState.val = {...formState.val, confidence: parseInt(e.target.value)};
            }
          })
        ]),
        button({
          type: "submit",
          disabled: formState.val.submitting,
          class: "submit-button"
        }, formState.val.submitting ? "Submitting..." : "Submit Prediction")
      ])
    ]);
  };
  
  // Assigned predictions component
  const AssignedPredictions = () => {
    const betFormState = van.state({
      assignmentId: null,
      prediction: null,
      confidenceLevel: 5,
      betOn: '',
      submitting: false,
      error: '',
      success: ''
    });
    
    const startBet = (assignment) => {
      betFormState.val = {
        ...betFormState.val,
        assignmentId: assignment.id,
        prediction: assignment
      };
    };
    
    const cancelBet = () => {
      betFormState.val = {
        ...betFormState.val,
        assignmentId: null,
        prediction: null,
        betOn: '',
        error: '',
        success: ''
      };
    };
    
    const submitBet = async (e) => {
      e.preventDefault();
      betFormState.val = {...betFormState.val, submitting: true, error: '', success: ''};
      
      try {
        const result = await placeBet(
          betFormState.val.assignmentId,
          betFormState.val.confidenceLevel,
          betFormState.val.betOn
        );
        
        if (result) {
          betFormState.val = {
            assignmentId: null,
            prediction: null,
            confidenceLevel: 5,
            betOn: '',
            submitting: false,
            error: '',
            success: 'Bet placed successfully!'
          };
          // Refresh data
          fetchAssignedPredictions();
          fetchBettingStats();
        } else {
          betFormState.val = {...betFormState.val, submitting: false, error: 'Failed to place bet'};
        }
      } catch (error) {
        betFormState.val = {...betFormState.val, submitting: false, error: error.message};
      }
    };
    
    // Bet form component
    const BetForm = () => {
      if (!betFormState.val.assignmentId) return null;
      
      return div({ class: "bet-form" }, [
        h3("Place Your Bet"),
        p(`Prediction: ${betFormState.val.prediction.event}`),
        p(`Original prediction: ${betFormState.val.prediction.prediction_value}`),
        
        () => betFormState.val.error ? div({ class: "error-message" }, betFormState.val.error) : null,
        () => betFormState.val.success ? div({ class: "success-message" }, betFormState.val.success) : null,
        
        form({ onsubmit: submitBet }, [
          div({ class: "form-group" }, [
            label({ for: "betOn" }, "Your Bet:"),
            select({
              id: "betOn",
              required: true,
              disabled: betFormState.val.submitting,
              value: betFormState.val.betOn,
              onchange: (e) => {
                betFormState.val = {...betFormState.val, betOn: e.target.value};
              }
            }, [
              option({ value: "" }, "-- Select your bet --"),
              option({ value: "yes" }, "Yes"),
              option({ value: "no" }, "No")
            ])
          ]),
          div({ class: "form-group" }, [
            label({ for: "confidenceLevel" }, `Confidence: ${betFormState.val.confidenceLevel}/10`),
            input({
              type: "range",
              id: "confidenceLevel",
              min: "1",
              max: "10",
              step: "1",
              disabled: betFormState.val.submitting,
              value: betFormState.val.confidenceLevel,
              onchange: (e) => {
                betFormState.val = {...betFormState.val, confidenceLevel: parseInt(e.target.value)};
              }
            })
          ]),
          div({ class: "form-buttons" }, [
            button({
              type: "submit",
              disabled: betFormState.val.submitting,
              class: "submit-button"
            }, betFormState.val.submitting ? "Submitting..." : "Place Bet"),
            button({
              type: "button",
              onclick: cancelBet,
              disabled: betFormState.val.submitting,
              class: "cancel-button"
            }, "Cancel")
          ])
        ])
      ]);
    };
    
    // Monthly stats
    const MonthlyStats = () => 
      div({ class: "monthly-stats" }, [
        h3("Monthly Betting Stats"),
        p([
          `Completed bets: ${bettingStatsState.val.completed_bets}/${bettingStatsState.val.total_assigned || 5}`,
          span({ class: "stat-highlight" }, ` (${bettingStatsState.val.remaining_bets} remaining)`)
        ])
      ]);
    
    return div({ class: "assigned-predictions" }, [
      h2("Your Assigned Predictions"),
      MonthlyStats(),
      () => betFormState.val.assignmentId ? BetForm() : null,
      
      () => assignedPredictionsState.val.length === 0 
        ? p("No assigned predictions for this month.")
        : div({ class: "prediction-list" }, 
            assignedPredictionsState.val.map(assignment => 
              div({ class: "prediction-card" }, [
                h3(assignment.event),
                p(`Original prediction: ${assignment.prediction_value}`),
                p(`Assigned on: ${new Date(assignment.assigned_at).toLocaleDateString()}`),
                button({
                  class: "bet-button",
                  onclick: () => startBet(assignment)
                }, "Place Bet")
              ])
            )
          )
    ]);
  };
  
  // User's predictions component
  const UserPredictions = () => 
    div({ class: "user-predictions" }, [
      h2("Your Predictions"),
      
      () => predictionsLoadingState.val 
        ? p("Loading predictions...")
        : predictionsState.val.length === 0 
          ? p("You haven't made any predictions yet.")
          : div({ class: "prediction-list" }, 
              predictionsState.val.map(prediction => 
                div({ 
                  class: `prediction-card ${prediction.outcome ? 'resolved' : 'pending'}`,
                  'data-outcome': prediction.outcome
                }, [
                  h3(prediction.event),
                  p(`Your prediction: ${prediction.prediction_value}`),
                  p(`Confidence: ${prediction.confidence}%`),
                  p(`Created: ${new Date(prediction.created_at).toLocaleDateString()}`),
                  prediction.outcome 
                    ? p({ class: `outcome ${prediction.outcome}` }, 
                        `Outcome: ${prediction.outcome.charAt(0).toUpperCase() + prediction.outcome.slice(1)}`
                      )
                    : p({ class: "pending" }, "Status: Pending")
                ])
              )
            )
    ]);
  
  // Predictions content
  const content = [
    h1("Predictions & Betting"),
    div({ class: "predictions-container" }, [
      div({ class: "predictions-column" }, [
        NewPredictionForm(),
        UserPredictions()
      ]),
      div({ class: "predictions-column" }, [
        AssignedPredictions()
      ])
    ])
  ];
  
  return main({ class: "main-content" }, content);
};

// Create a Profile page component
const ProfilePage = () => {
  // Fetch profile data when the page is loaded
  setTimeout(() => {
    if (isLoggedInState.val) {
      fetchUserProfile();
      fetchPredictions();
      
      // Fetch followers/following after profile is loaded (needs user ID)
      setTimeout(() => {
        if (userProfileState.val) {
          fetchFollowers();
          fetchFollowing();
        }
      }, 100);
    }
  }, 10);
  
  // Profile editing component
  const ProfileEditor = () => {
    const editState = van.state({
      editing: false,
      bio: userProfileState.val?.bio || '',
      submitting: false,
      error: '',
      success: ''
    });
    
    const startEditing = () => {
      editState.val = {
        ...editState.val,
        editing: true,
        bio: userProfileState.val?.bio || '',
        error: '',
        success: ''
      };
    };
    
    const cancelEditing = () => {
      editState.val = {
        ...editState.val,
        editing: false,
        error: '',
        success: ''
      };
    };
    
    const saveProfile = async (e) => {
      e.preventDefault();
      editState.val = {...editState.val, submitting: true, error: '', success: ''};
      
      try {
        const result = await updateUserProfile(editState.val.bio);
        
        if (result) {
          editState.val = {
            ...editState.val,
            editing: false,
            submitting: false,
            error: '',
            success: 'Profile updated successfully!'
          };
          // Clear success message after 3 seconds
          setTimeout(() => {
            editState.val = {...editState.val, success: ''};
          }, 3000);
        } else {
          editState.val = {...editState.val, submitting: false, error: 'Failed to update profile'};
        }
      } catch (error) {
        editState.val = {...editState.val, submitting: false, error: error.message};
      }
    };
    
    return div({ class: "profile-editor" }, [
      () => editState.val.error ? div({ class: "error-message" }, editState.val.error) : null,
      () => editState.val.success ? div({ class: "success-message" }, editState.val.success) : null,
      
      () => editState.val.editing 
        ? form({ onsubmit: saveProfile }, [
            div({ class: "form-group" }, [
              label({ for: "bio" }, "Bio:"),
              textarea({
                id: "bio",
                rows: 4,
                disabled: editState.val.submitting,
                value: editState.val.bio,
                onchange: (e) => {
                  editState.val = {...editState.val, bio: e.target.value};
                }
              })
            ]),
            div({ class: "form-buttons" }, [
              button({
                type: "submit",
                disabled: editState.val.submitting,
                class: "submit-button"
              }, editState.val.submitting ? "Saving..." : "Save Profile"),
              button({
                type: "button",
                onclick: cancelEditing,
                disabled: editState.val.submitting,
                class: "cancel-button"
              }, "Cancel")
            ])
          ])
        : button({
            onclick: startEditing,
            class: "edit-button"
          }, "Edit Profile")
    ]);
  };
  
  // User info component
  const UserInfo = () => 
    div({ class: "user-info" }, [
      h2("Profile"),
      
      () => !userProfileState.val 
        ? p("Loading profile...")
        : div([
            h3(userProfileState.val.username),
            p({ class: "email" }, userProfileState.val.email),
            div({ class: "bio" }, [
              h4("Bio"),
              p(userProfileState.val.bio || "No bio provided")
            ]),
            ProfileEditor()
          ])
    ]);
  
  // Network component (followers/following)
  const Network = () => 
    div({ class: "network" }, [
      h3("Your Network"),
      
      div({ class: "network-stats" }, [
        div({ class: "stat" }, [
          span({ class: "stat-label" }, "Followers: "),
          span({ class: "stat-value" }, followersState.val.length)
        ]),
        div({ class: "stat" }, [
          span({ class: "stat-label" }, "Following: "),
          span({ class: "stat-value" }, followingState.val.length)
        ])
      ]),
      
      div({ class: "network-tabs" }, [
        h4("Followers"),
        () => followersState.val.length === 0 
          ? p("No followers yet.")
          : ul({ class: "user-list" }, 
              followersState.val.map(user => 
                li({ class: "user-item" }, [
                  div({ class: "username" }, user.username),
                  div({ class: "user-bio" }, user.bio || "No bio")
                ])
              )
            ),
        
        h4("Following"),
        () => followingState.val.length === 0 
          ? p("Not following anyone yet.")
          : ul({ class: "user-list" }, 
              followingState.val.map(user => 
                li({ class: "user-item" }, [
                  div({ class: "username" }, user.username),
                  div({ class: "user-bio" }, user.bio || "No bio")
                ])
              )
            )
      ])
    ]);
  
  // Profile predictions component
  const ProfilePredictions = () => 
    div({ class: "profile-predictions" }, [
      h3("Your Predictions"),
      
      () => predictionsLoadingState.val 
        ? p("Loading predictions...")
        : predictionsState.val.length === 0 
          ? p("You haven't made any predictions yet.")
          : div({ class: "prediction-list-compact" }, 
              predictionsState.val.slice(0, 5).map(prediction => 
                div({ 
                  class: `prediction-item ${prediction.outcome ? 'resolved' : 'pending'}`,
                  'data-outcome': prediction.outcome
                }, [
                  div({ class: "prediction-event" }, prediction.event),
                  div({ class: "prediction-details" }, [
                    span(`${prediction.prediction_value} (${prediction.confidence}%)`),
                    prediction.outcome 
                      ? span({ class: `outcome ${prediction.outcome}` }, prediction.outcome)
                      : span({ class: "pending" }, "Pending")
                  ])
                ])
              )
            ),
      
      button({
        onclick: () => {
          window.location.hash = 'predictions';
        },
        class: "view-all-button"
      }, "View All Predictions")
    ]);
  
  // Profile content
  const content = [
    h1("My Profile"),
    div({ class: "profile-container" }, [
      div({ class: "profile-column main" }, [
        UserInfo(),
        ProfilePredictions()
      ]),
      div({ class: "profile-column sidebar" }, [
        Network()
      ])
    ])
  ];
  
  return main({ class: "main-content" }, content);
};

// Create a main content page component
const MainPage = () => {
  const content = [
    LoginNotice(),
    ContentsElem(),
    PostsSection()
  ];
  return main({ class: "main-content" }, content);
};

// App component combines all pieces into a cohesive layout
const App = () => 
  div({ class: "app-container" }, [
    // Main content wrapper
    div({ class: "wrapper" }, [
      headerElem,
      div({ class: "header-nav" }, Nav()),
      // Content container with sidebar and main content side by side
      div({ class: "content-container" }, [
        // Sidebar (shown on all pages)
        Sidebar(),
        // This function runs whenever currentPage.val changes
        () => {
          // Handle routing based on the current page
          switch(currentPage.val) {
            case 'login':
              return LoginPage();
            case 'predictions':
              return PredictionsPage();
            case 'profile':
              return ProfilePage();
            default:
              return MainPage();
          }
        }
      ])
    ])
  ]);

// Export a function returning the design component with posts
export function createDesign() {
  // Initialize app state
  checkAuth();
  updatePageFromHash();
  
  // Fetch posts
  setTimeout(() => {
    fetchPosts();
    viewReady.val = true;
  }, 50);

  // Return the app component
  return App();
}