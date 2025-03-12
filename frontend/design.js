import van from './van-1.5.3.min.js';
const { div, header, main, section, h2, ul, li, a, p, span, button, form, input, label } = van.tags;

// Inject CSS into the document head only once
if (!document.getElementById("design-style")) {
  const style = document.createElement("style");
  style.id = "design-style";
  style.textContent = `
    :root {
      --blue-bg: #0000ff;
      --black-bg: #000;
      --text-color: #000;
    }
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: 'Courier New', Courier, monospace;
      line-height: 1.5;
      background-color: var(--blue-bg);
    }
    .header-box {
      border: 2px solid black;
      margin: 2rem auto;
      background: white;
      width: fit-content;
      min-width: 600px;
    }
    .header-content {
      display: grid;
      grid-template-columns: auto 100px 100px;
    }
    .header-item {
      padding: 0.5rem 1rem;
      border: 1px solid black;
    }
    .title {
      font-weight: bold;
      font-size: 1.2rem;
    }
    .subtitle {
      font-size: 0.9rem;
      grid-column: 1 / -1;
      border-top: 1px solid black;
      padding: 0.5rem 1rem;
    }
    .header-nav {
      text-align: right;
      padding: 0.5rem 2rem;
      margin: 0 auto;
      max-width: 800px;
    }
    .nav {
      display: flex;
      justify-content: flex-end;
    }
    .main-content {
      background: white;
      padding: 2rem;
      margin: 0 auto;
      min-height: 100vh;
      max-width: 800px;
    }
    .contents {
      margin-bottom: 2rem;
    }
    h2 {
      margin: 1.5rem 0 1rem;
      font-size: 1rem;
      font-weight: bold;
    }
    ul {
      list-style-type: none;
      margin-left: 1rem;
    }
    li {
      margin: 0.5rem 0;
    }
    a {
      color: var(--text-color);
      text-decoration: underline;
    }
    p {
      margin: 1rem 0;
      max-width: 70ch;
    }
    .post {
      margin-bottom: 2rem;
      border-bottom: 1px dashed #000;
      padding-bottom: 1rem;
    }
    .post-title {
      font-weight: bold;
      margin-bottom: 0.25rem;
    }
    .post-meta {
      font-size: 0.8rem;
      color: #555;
      margin-bottom: 0.5rem;
    }
    .loading {
      font-style: italic;
      color: #555;
    }
    .error {
      color: red;
      border: 1px solid red;
      padding: 0.5rem;
      margin: 1rem 0;
    }
    .login-notice {
      border: 1px dashed #000;
      padding: 1rem;
      margin: 1rem 0;
      text-align: center;
    }
    .login-container {
      max-width: 400px;
      margin: 2rem auto;
      padding: 2rem;
      border: 1px solid black;
      background: white;
    }
    .login-form {
      display: flex;
      flex-direction: column;
      gap: 1rem;
      margin: 1.5rem 0;
    }
    .form-group {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .form-group label {
      font-weight: bold;
    }
    .form-group input {
      padding: 0.5rem;
      border: 1px solid black;
      font-family: 'Courier New', Courier, monospace;
    }
    .error-message {
      color: red;
      border: 1px solid red;
      padding: 0.5rem;
      margin: 1rem 0;
    }
    button {
      font-family: 'Courier New', Courier, monospace;
      background: white;
      border: 1px solid black;
      padding: 0.25rem 0.5rem;
      cursor: pointer;
      margin: 0.5rem;
    }
    button:hover {
      background: #eee;
    }
  `;
  document.head.appendChild(style);
}

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

console.log('Initial page state:', currentPage.val);

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

// Fetch posts from the API
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
      headers: { 'Authorization': `Bearer ${tokenState.val}` }
    });
    
    if (!response.ok) {
      if (response.status === 401) {
        // Handle unauthorized - clear token and update state
        localStorage.removeItem('token');
        isLoggedInState.val = false;
        throw new Error('Session expired. Please log in again.');
      }
      throw new Error(`Failed to fetch posts: ${response.statusText}`);
    }
    
    const data = await response.json();
    postsState.val = Array.isArray(data) ? data : 
                     (data.posts ? data.posts : []);
  } catch (error) {
    console.error('Error fetching posts:', error);
    errorState.val = error.message;
    // Load mock data if in development
    if (window.location.hostname === 'localhost' || 
        window.location.hostname === '127.0.0.1') {
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
  console.log('Current page updated to:', currentPage.val);
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
    console.log('Login attempt with:', email);
    
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    console.log('Login response status:', response.status);
    
    if (!response.ok) {
      const error = await response.text();
      console.log('Login error text:', error);
      throw new Error(error || 'Login failed');
    }

    const data = await response.json();
    console.log('Login successful, got token');
    
    localStorage.setItem('token', data.token);
    tokenState.val = data.token;
    isLoggedInState.val = true;
    
    console.log('Redirecting to home page');
    window.location.hash = 'home';
    fetchPosts(); // Refresh posts with authenticated request
  } catch (error) {
    console.error('Login error:', error);
    loginError.val = error.message;
  }
};

// Logout function
const logout = () => {
  localStorage.removeItem('token');
  tokenState.val = '';
  isLoggedInState.val = false;
  window.location.hash = 'login';
  loadMockPosts(); // Load mock posts after logout
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
  if (isLoggedInState.val) return null;
  
  return div({ class: "login-notice" }, [
    p("You are viewing public posts. Log in to see personalized content."),
    button({ 
      onclick: () => { 
        window.location.hash = 'login';
        console.log('Login button clicked, hash now:', window.location.hash);
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

// Router component for different pages
const Router = () => {
  console.log('Router rendering for page:', currentPage.val);
  if (currentPage.val === 'login') {
    return LoginForm();
  } else {
    return div([
      LoginNotice(),
      ContentsElem(),
      PostsSection()
    ]);
  }
};

// Create a custom login page component
const LoginPage = () => 
  main({ class: "main-content" }, LoginForm());

// Create a main content page component
const MainPage = () => 
  main({ class: "main-content" }, [
    LoginNotice(),
    ContentsElem(),
    PostsSection()
  ]);

// Export a function returning the design component with posts
export function createDesign() {
  // Check auth status and fetch posts when the component is created
  checkAuth();
  
  // Fetch posts
  fetchPosts();
  
  // Ensure currentPage reactivity by creating an effect on hash changes
  window.addEventListener('hashchange', () => {
    // Update the reactive state with the new hash
    currentPage.val = window.location.hash.slice(1) || 'home';
    console.log('Hash changed, updated currentPage to:', currentPage.val);
  });
  
  // Return the reactive component structure
  return div(null, [
    headerElem,
    div({ class: "header-nav" }, Nav()),
    // This function runs whenever currentPage.val changes
    () => {
      console.log('Rendering page for:', currentPage.val);
      return currentPage.val === 'login' ? LoginPage() : MainPage();
    }
  ]);
}