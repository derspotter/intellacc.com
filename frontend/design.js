import van from './van-1.5.3.min.js';
const { div, header, main, section, h2, ul, li, a, p, span, button, form, input, label } = van.tags;

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
          return currentPage.val === 'login' ? LoginPage() : MainPage();
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