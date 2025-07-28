#!/usr/bin/env node

/**
 * Integration test for the edit post feature
 * Tests against the running Docker backend server
 */

const axios = require('axios');

const BASE_URL = 'http://localhost:3000/api';

async function runTests() {
  console.log('🧪 Testing Edit Post Feature Integration...\n');
  
  let authToken = '';
  let userId = '';
  let postId = '';
  
  try {
    // Step 1: Register a test user
    console.log('1️⃣  Registering test user...');
    const registerResponse = await axios.post(`${BASE_URL}/auth/register`, {
      username: `testuser_${Date.now()}`,
      email: `test_${Date.now()}@example.com`,
      password: 'password123'
    });
    
    if (registerResponse.status === 201) {
      console.log('✅ User registered successfully');
      authToken = registerResponse.data.token;
      
      // Decode token to get user ID
      const payload = JSON.parse(Buffer.from(authToken.split('.')[1], 'base64').toString());
      userId = payload.userId;
      console.log(`   User ID: ${userId}`);
    } else {
      throw new Error('Failed to register user');
    }
    
    // Step 2: Create a test post
    console.log('\n2️⃣  Creating test post...');
    const createPostResponse = await axios.post(`${BASE_URL}/posts`, {
      content: 'This is a test post that we will edit later!'
    }, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    
    if (createPostResponse.status === 201) {
      postId = createPostResponse.data.id;
      console.log('✅ Post created successfully');
      console.log(`   Post ID: ${postId}`);
      console.log(`   Original content: "${createPostResponse.data.content}"`);
    } else {
      throw new Error('Failed to create post');
    }
    
    // Step 3: Test editing the post (should succeed - user owns the post)
    console.log('\n3️⃣  Testing post edit by owner...');
    const editPostResponse = await axios.patch(`${BASE_URL}/posts/${postId}`, {
      content: 'This post has been edited successfully! 🎉'
    }, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    
    if (editPostResponse.status === 200) {
      console.log('✅ Post edited successfully by owner');
      console.log(`   New content: "${editPostResponse.data.content}"`);
    } else {
      throw new Error('Failed to edit post');
    }
    
    // Step 4: Register another user
    console.log('\n4️⃣  Registering second user...');
    const registerResponse2 = await axios.post(`${BASE_URL}/auth/register`, {
      username: `testuser2_${Date.now()}`,
      email: `test2_${Date.now()}@example.com`,
      password: 'password123'
    });
    
    let authToken2 = '';
    if (registerResponse2.status === 201) {
      authToken2 = registerResponse2.data.token;
      console.log('✅ Second user registered successfully');
    } else {
      throw new Error('Failed to register second user');
    }
    
    // Step 5: Test editing the post with unauthorized user (should fail)
    console.log('\n5️⃣  Testing post edit by non-owner (should fail)...');
    try {
      await axios.patch(`${BASE_URL}/posts/${postId}`, {
        content: 'Trying to edit someone else\'s post!'
      }, {
        headers: { Authorization: `Bearer ${authToken2}` }
      });
      console.log('❌ SECURITY ISSUE: Non-owner was able to edit the post!');
    } catch (error) {
      if (error.response && error.response.status === 403) {
        console.log('✅ Authorization check working: Non-owner correctly denied access');
      } else {
        console.log(`❌ Unexpected error: ${error.message}`);
      }
    }
    
    // Step 6: Test editing non-existent post (should fail)
    console.log('\n6️⃣  Testing edit of non-existent post...');
    try {
      await axios.patch(`${BASE_URL}/posts/99999`, {
        content: 'Trying to edit non-existent post!'
      }, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      console.log('❌ ISSUE: Was able to edit non-existent post!');
    } catch (error) {
      if (error.response && error.response.status === 404) {
        console.log('✅ Not found check working: Non-existent post correctly returns 404');
      } else {
        console.log(`❌ Unexpected error: ${error.message}`);
      }
    }
    
    console.log('\n🎉 All edit post feature tests completed successfully!');
    
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    process.exit(1);
  }
}

// Handle both direct execution and module import
if (require.main === module) {
  runTests();
}

module.exports = { runTests };
