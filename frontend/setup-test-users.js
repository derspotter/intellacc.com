// setup-test-users.js - Script to create test users and content
// Run with: node setup-test-users.js

const API_BASE = 'http://backend:3000/api'; // Direct connection to backend service

// Test user data
const users = [
  {
    username: 'testuser1',
    email: 'user1@example.com',
    password: 'password123'
  },
  {
    username: 'testuser2',
    email: 'user2@example.com',
    password: 'password123'
  },
  // Add admin user
  {
    username: 'adminuser',
    email: 'admin@example.com',
    password: 'adminpass',
    role: 'admin'
  }
];

// Sample posts
const posts = [
  {
    content: 'First post by User 1: This is a test post created by User 1. Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
    image_url: null
  },
  {
    content: 'Hello from User 2: Testing the posting functionality. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
    image_url: null
  },
  {
    content: 'Another post from User 1: Multiple posts test. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.',
    image_url: null
  },
  {
    content: 'User 2 shares thoughts: Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.',
    image_url: null
  }
];

// Sample prediction events
const events = [
  {
    title: "Will the price of Bitcoin exceed $100,000 by the end of 2025?",
    details: "Bitcoin price must reach or exceed $100,000 USD on any major exchange before January 1, 2026.",
    closing_date: "2025-12-31"
  },
  {
    title: "Will AI systems achieve human-level reasoning by 2030?",
    details: "As determined by performance on standardized tests and problem-solving benchmarks.",
    closing_date: "2030-01-01"
  },
  {
    title: "Will SpaceX land humans on Mars before 2030?",
    details: "Must be a crewed mission that successfully lands on Mars and returns safely.",
    closing_date: "2029-12-31"
  }
];

// Helper function for API requests
async function apiRequest(endpoint, method, body, token) {
  const headers = {
    'Content-Type': 'application/json'
  };
  
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API request failed: ${text}`);
  }
  
  return response.json();
}

// Main function to set up test users and content
async function setupTestUsers() {
  console.log('Setting up test users and content...');
  const userTokens = [];
  const userIds = [];
  let adminToken = null;
  
  try {
    // Create users
    for (const user of users) {
      try {
        // Try to create user
        await apiRequest('/users', 'POST', user);
        console.log(`Created user: ${user.username}`);
      } catch (error) {
        console.log(`User might already exist: ${error.message}`);
      }
      
      // Login and get token
      const loginData = await apiRequest('/login', 'POST', {
        email: user.email,
        password: user.password
      });
      
      // Store admin token separately
      if (user.role === 'admin') {
        adminToken = loginData.token;
        console.log('Got admin token');
      } else {
        userTokens.push(loginData.token);
      }
      
      console.log(`Logged in as ${user.username}`);
      
      // Get user profile to get ID
      const profile = await apiRequest('/me', 'GET', null, loginData.token);
      userIds.push(profile.id);
      console.log(`Got user ID: ${profile.id}`);
    }
    
    // Make users follow each other
    try {
      await apiRequest(`/users/${userIds[1]}/follow`, 'POST', {}, userTokens[0]);
      console.log(`User 1 is now following User 2`);
    } catch (error) {
      console.log(`User 1 might already be following User 2: ${error.message}`);
    }
    
    try {
      await apiRequest(`/users/${userIds[0]}/follow`, 'POST', {}, userTokens[1]);
      console.log(`User 2 is now following User 1`);
    } catch (error) {
      console.log(`User 2 might already be following User 1: ${error.message}`);
    }
    
    // Create posts for each user
    try {
      await apiRequest('/posts', 'POST', posts[0], userTokens[0]);
      console.log('Created post 1 by User 1');
    } catch (error) {
      console.log(`Error creating post 1: ${error.message}`);
    }
    
    try {
      await apiRequest('/posts', 'POST', posts[1], userTokens[1]);
      console.log('Created post 2 by User 2');
    } catch (error) {
      console.log(`Error creating post 2: ${error.message}`);
    }
    
    try {
      await apiRequest('/posts', 'POST', posts[2], userTokens[0]);
      console.log('Created post 3 by User 1');
    } catch (error) {
      console.log(`Error creating post 3: ${error.message}`);
    }
    
    try {
      await apiRequest('/posts', 'POST', posts[3], userTokens[1]);
      console.log('Created post 4 by User 2');
    } catch (error) {
      console.log(`Error creating post 4: ${error.message}`);
    }
    
    // Create prediction events if admin token is available
    if (adminToken) {
      console.log('\nCreating prediction events...');
      for (const event of events) {
        try {
          await apiRequest('/events', 'POST', event, adminToken);
          console.log(`Created event: ${event.title}`);
        } catch (error) {
          console.log(`Error creating event: ${error.message}`);
        }
      }
    }
    
    console.log('\nSetup complete! You can now log in with:');
    console.log('User 1: email=user1@example.com, password=password123');
    console.log('User 2: email=user2@example.com, password=password123');
    console.log('Admin: email=admin@example.com, password=adminpass');
    
  } catch (error) {
    console.error('Error during setup:', error);
  }
}

// Run the setup
setupTestUsers();