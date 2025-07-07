#!/usr/bin/env node

/**
 * Database Population Script
 * 
 * Generates realistic test data:
 * - 1000 random users with varied profiles
 * - Random follow relationships (realistic social network patterns)
 * - Diverse events across multiple categories
 * - Thousands of predictions with varied accuracy
 * - Posts and comments to populate the feed
 * - Reputation scores and time-weighted data
 */

const { Client } = require('pg');
const bcrypt = require('bcrypt');

// Database configuration - use Docker network hostname
const dbConfig = {
  user: 'intellacc_user',
  host: 'db', // Docker network hostname
  database: 'intellaccdb',
  password: 'supersecretpassword',
  port: 5432,
};

// Realistic name pools
const firstNames = [
  'Alex', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Avery', 'Quinn', 'Sage', 'River',
  'Emma', 'Liam', 'Olivia', 'Noah', 'Ava', 'Ethan', 'Sophia', 'Mason', 'Isabella', 'William',
  'Mia', 'James', 'Charlotte', 'Benjamin', 'Amelia', 'Lucas', 'Harper', 'Henry', 'Evelyn', 'Alexander',
  'Abigail', 'Michael', 'Emily', 'Daniel', 'Elizabeth', 'Jacob', 'Sofia', 'Logan', 'Avery', 'Jackson',
  'Ella', 'Levi', 'Madison', 'Sebastian', 'Scarlett', 'Mateo', 'Victoria', 'Jack', 'Aria', 'Owen',
  'Chloe', 'Theodore', 'Grace', 'Aiden', 'Camila', 'Samuel', 'Penelope', 'Joseph', 'Layla', 'John',
  'Riley', 'David', 'Zoey', 'Wyatt', 'Nora', 'Matthew', 'Lily', 'Luke', 'Eleanor', 'Asher',
  'Hannah', 'Carter', 'Lillian', 'Julian', 'Addison', 'Grayson', 'Aubrey', 'Leo', 'Ellie', 'Jayden',
  'Stella', 'Gabriel', 'Natalie', 'Isaac', 'Zoe', 'Oliver', 'Leah', 'Jonathan', 'Hazel', 'Ezra',
  'Violet', 'Thomas', 'Aurora', 'Charles', 'Savannah', 'Christopher', 'Audrey', 'Jaxon', 'Brooklyn', 'Maverick'
];

const lastNames = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez',
  'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin',
  'Lee', 'Perez', 'Thompson', 'White', 'Harris', 'Sanchez', 'Clark', 'Ramirez', 'Lewis', 'Robinson',
  'Walker', 'Young', 'Allen', 'King', 'Wright', 'Scott', 'Torres', 'Nguyen', 'Hill', 'Flores',
  'Green', 'Adams', 'Nelson', 'Baker', 'Hall', 'Rivera', 'Campbell', 'Mitchell', 'Carter', 'Roberts',
  'Chen', 'Kumar', 'Singh', 'Patel', 'Kim', 'Park', 'Liu', 'Wang', 'Zhang', 'Yang',
  'Cohen', 'Murphy', 'Cook', 'Cooper', 'Reed', 'Morgan', 'Bell', 'Bailey', 'Ward', 'Cox',
  'Richardson', 'Wood', 'Watson', 'Brooks', 'Bennett', 'Gray', 'James', 'Reyes', 'Cruz', 'Hughes',
  'Price', 'Myers', 'Long', 'Foster', 'Sanders', 'Ross', 'Morales', 'Powell', 'Sullivan', 'Russell',
  'Ortiz', 'Jenkins', 'Gutierrez', 'Perry', 'Butler', 'Barnes', 'Fisher', 'Henderson', 'Coleman', 'Simmons'
];

// Bio templates
const bioTemplates = [
  'Passionate about {interest}. {hobby} enthusiast.',
  'Professional {profession}. Love {interest} and {hobby}.',
  '{hobby} lover and {interest} advocate.',
  'Exploring the world of {interest}. {hobby} in my spare time.',
  '{profession} by day, {hobby} by night.',
  'Making predictions about {interest}. {hobby} addict.',
  'Data-driven {profession}. Fascinated by {interest}.',
  '{hobby} and {interest} are my passions.',
  'Always learning about {interest}. Weekend {hobby}.',
  'Professional forecaster specializing in {interest}.'
];

const interests = [
  'technology', 'politics', 'economics', 'sports', 'science', 'climate change', 'cryptocurrency',
  'artificial intelligence', 'space exploration', 'renewable energy', 'biotechnology', 'finance',
  'geopolitics', 'social media', 'gaming', 'entertainment', 'healthcare', 'education'
];

const hobbies = [
  'reading', 'hiking', 'photography', 'cooking', 'traveling', 'gaming', 'programming',
  'writing', 'cycling', 'running', 'chess', 'music', 'art', 'gardening', 'fishing',
  'rock climbing', 'surfing', 'skiing', 'dancing', 'meditation'
];

const professions = [
  'engineer', 'analyst', 'researcher', 'consultant', 'developer', 'scientist', 'teacher',
  'designer', 'writer', 'manager', 'entrepreneur', 'economist', 'statistician', 'trader',
  'journalist', 'lawyer', 'doctor', 'professor', 'student', 'freelancer'
];

// Topic areas for post content
const topics = [
  'technology', 'politics', 'economics', 'sports', 'science', 'climate change', 'cryptocurrency',
  'artificial intelligence', 'space exploration', 'renewable energy', 'biotechnology', 'finance',
  'geopolitics', 'social media', 'gaming', 'entertainment', 'healthcare', 'education'
];

// Post content templates
const postTemplates = [
  'Just made a prediction about {topic}. What do you think?',
  'Interesting developments in {topic}. My confidence is shifting.',
  'The data on {topic} is compelling. Updated my forecast.',
  'Breaking: new information about {topic} changes everything.',
  'Analysis of {topic} trends suggests {outcome}.',
  'My prediction on {topic} is looking {status}. Here\'s why:',
  'Fascinating discussion about {topic} at today\'s conference.',
  'The {topic} situation is evolving faster than expected.',
  'Key insights on {topic} that might affect predictions.',
  'Reviewing my {topic} forecasts after recent events.'
];

// Utility functions
function random(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min, max, decimals = 2) {
  return parseFloat((Math.random() * (max - min) + min).toFixed(decimals));
}

function randomDate(start, end) {
  return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
}


// Generate realistic social network follows
function generateFollowNetwork(userCount) {
  const follows = [];
  const followersPerUser = new Map();
  
  // Initialize follower counts
  for (let i = 1; i <= userCount; i++) {
    followersPerUser.set(i, 0);
  }
  
  for (let followerId = 1; followerId <= userCount; followerId++) {
    // Most users follow 10-50 people, some follow many more (power law distribution)
    const followCount = Math.random() < 0.1 ? 
      randomInt(50, 200) :  // 10% are heavy followers
      randomInt(5, 50);     // 90% are normal users
    
    const following = new Set();
    
    for (let i = 0; i < followCount; i++) {
      let followingId;
      let attempts = 0;
      
      do {
        // Bias towards users with more followers (preferential attachment)
        if (Math.random() < 0.3) {
          // 30% chance to follow a popular user
          const popularUsers = Array.from(followersPerUser.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, Math.floor(userCount * 0.1))
            .map(entry => entry[0]);
          followingId = popularUsers.length > 0 ? random(popularUsers) : randomInt(1, userCount);
        } else {
          // 70% chance to follow a random user
          followingId = randomInt(1, userCount);
        }
        attempts++;
      } while ((following.has(followingId) || followingId === followerId) && attempts < 20);
      
      if (followingId !== followerId && !following.has(followingId)) {
        following.add(followingId);
        follows.push([followerId, followingId]);
        followersPerUser.set(followingId, followersPerUser.get(followingId) + 1);
      }
    }
  }
  
  return follows;
}

// Main population function
async function populateDatabase() {
  const client = new Client(dbConfig);
  
  try {
    await client.connect();
    console.log('Connected to database');
    
    // Clear existing data (except admin user and events)
    console.log('Clearing existing test data...');
    await client.query('DELETE FROM likes WHERE user_id > 3');
    await client.query('DELETE FROM posts WHERE user_id > 3');
    await client.query('DELETE FROM predictions WHERE user_id > 3');
    await client.query('DELETE FROM follows WHERE follower_id > 3 OR following_id > 3');
    await client.query('DELETE FROM user_reputation WHERE user_id > 3');
    await client.query('DELETE FROM users WHERE id > 3');
    
    // Reset sequence
    await client.query('SELECT setval(\'users_id_seq\', (SELECT COALESCE(MAX(id), 0) FROM users))');
    
    console.log('Generating 1000 users...');
    const users = [];
    const hashedPassword = await bcrypt.hash('password123', 10);
    
    for (let i = 0; i < 1000; i++) {
      const firstName = random(firstNames);
      const lastName = random(lastNames);
      const username = `${firstName.toLowerCase()}${lastName.toLowerCase()}${randomInt(1, 999)}`;
      const email = `${username}@example.com`;
      
      const bio = random(bioTemplates)
        .replace('{interest}', random(interests))
        .replace('{hobby}', random(hobbies))
        .replace('{profession}', random(professions));
      
      const result = await client.query(
        `INSERT INTO users (username, email, password_hash, bio, role, created_at) 
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [username, email, hashedPassword, bio, 'user', randomDate(new Date(2023, 0, 1), new Date())]
      );
      
      users.push({
        id: result.rows[0].id,
        username,
        email,
        bio
      });
    }
    
    console.log('Creating follow relationships...');
    const follows = generateFollowNetwork(users.length);
    
    for (const [followerId, followingId] of follows) {
      try {
        await client.query(
          'INSERT INTO follows (follower_id, following_id, created_at) VALUES ($1, $2, $3)',
          [users[followerId - 1].id, users[followingId - 1].id, randomDate(new Date(2023, 6, 1), new Date())]
        );
      } catch (err) {
        // Skip duplicates
      }
    }
    
    console.log('Loading existing events...');
    const eventsResult = await client.query('SELECT id, title, event_type, outcome FROM events');
    const events = eventsResult.rows.map(row => ({
      id: row.id,
      title: row.title,
      event_type: row.event_type,
      resolved: row.outcome !== null,
      actual_outcome: row.outcome
    }));
    
    console.log(`Found ${events.length} existing events to use for predictions`);
    
    console.log('Generating predictions...');
    let predictionCount = 0;
    
    for (const user of users) {
      // Each user makes 5-25 predictions
      const userPredictionCount = randomInt(5, 25);
      
      for (let i = 0; i < userPredictionCount; i++) {
        const event = random(events);
        
        // Generate prediction based on event type
        let predictionValue, confidence, numericalValue, outcome;
        
        if (event.event_type === 'binary') {
          predictionValue = random(['yes', 'no']);
          confidence = randomInt(55, 95); // Most people are overconfident
          
          if (event.resolved) {
            outcome = predictionValue === event.actual_outcome ? 'correct' : 'incorrect';
          }
        } else if (event.event_type === 'numeric') {
          numericalValue = randomFloat(1, 1000);
          predictionValue = numericalValue.toString();
          confidence = randomInt(60, 90);
          
          if (event.resolved) {
            // Simulate some being close to actual values
            const actualValue = randomFloat(1, 1000);
            const accuracy = Math.abs(numericalValue - actualValue) / actualValue;
            outcome = accuracy < 0.2 ? 'correct' : 'incorrect';
          }
        } else {
          predictionValue = random(['Option A', 'Option B', 'Option C']);
          confidence = randomInt(50, 85);
          
          if (event.resolved) {
            outcome = Math.random() < 0.33 ? 'correct' : 'incorrect';
          }
        }
        
        const createdAt = randomDate(new Date(2023, 6, 1), new Date());
        const resolvedAt = event.resolved ? randomDate(createdAt, new Date()) : null;
        
        // Calculate raw_log_loss for resolved predictions
        let rawLogLoss = null;
        if (outcome) {
          const prob = confidence / 100;
          if (event.event_type === 'binary') {
            rawLogLoss = outcome === 'correct' ? 
              -Math.log(prob) : 
              -Math.log(1 - prob);
          } else {
            // For non-binary, use simplified log loss
            rawLogLoss = outcome === 'correct' ? 
              -Math.log(prob) : 
              -Math.log((1 - prob) / 2); // Distribute remaining probability
          }
        }
        
        try {
          await client.query(
            `INSERT INTO predictions (user_id, event_id, event, prediction_value, confidence, 
             created_at, resolved_at, outcome, prediction_type, numerical_value, raw_log_loss) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              user.id, event.id, event.title, predictionValue, confidence,
              createdAt, resolvedAt, outcome || 'pending', event.event_type, 
              numericalValue, rawLogLoss
            ]
          );
          predictionCount++;
        } catch (err) {
          // Skip duplicates
        }
      }
    }
    
    console.log('Generating user reputation scores...');
    for (const user of users) {
      // Calculate basic reputation metrics
      const userPredictions = await client.query(
        'SELECT * FROM predictions WHERE user_id = $1 AND outcome != $2',
        [user.id, 'pending']
      );
      
      if (userPredictions.rows.length > 0) {
        const correctPredictions = userPredictions.rows.filter(p => p.outcome === 'correct').length;
        const totalPredictions = userPredictions.rows.length;
        const accuracy = correctPredictions / totalPredictions;
        
        // Calculate average log loss
        const logLosses = userPredictions.rows
          .filter(p => p.raw_log_loss !== null)
          .map(p => parseFloat(p.raw_log_loss));
        const avgLogLoss = logLosses.length > 0 ? 
          logLosses.reduce((a, b) => a + b, 0) / logLosses.length : 1.0;
        
        // Time-weighted score (simplified)
        const timeWeightedScore = avgLogLoss;
        
        // Peer bonus (simplified - based on prediction count)
        const peerBonus = Math.min(totalPredictions * 0.01, 0.5);
        
        // Reputation points using tanh formula: Rep = 10 * tanh(-(Acc + R)) + 1
        const repInput = -(timeWeightedScore + peerBonus);
        const repPoints = 10 * Math.tanh(repInput) + 1;
        
        await client.query(
          `INSERT INTO user_reputation (user_id, rep_points, time_weighted_score, peer_bonus, updated_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [user.id, repPoints, timeWeightedScore, peerBonus, new Date()]
        );
      }
    }
    
    console.log('Generating posts and comments...');
    const posts = [];
    
    // Generate main posts
    for (let i = 0; i < 500; i++) {
      const user = random(users);
      const topic = random(topics);
      const status = random(['good', 'bad', 'uncertain']);
      const outcome = random(['bullish', 'bearish', 'mixed']);
      
      const content = random(postTemplates)
        .replace('{topic}', topic)
        .replace('{status}', status)
        .replace('{outcome}', outcome);
      
      const createdAt = randomDate(new Date(2023, 6, 1), new Date());
      
      const result = await client.query(
        `INSERT INTO posts (user_id, content, created_at, is_comment, parent_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [user.id, content, createdAt, false, null]
      );
      
      posts.push({
        id: result.rows[0].id,
        user_id: user.id,
        created_at: createdAt
      });
    }
    
    // Generate comments
    for (let i = 0; i < 800; i++) {
      const post = random(posts);
      const user = random(users);
      const comments = [
        'Interesting perspective!',
        'I disagree with this prediction.',
        'Great analysis, thanks for sharing.',
        'What data are you basing this on?',
        'This aligns with my research.',
        'I think you\'re being too optimistic.',
        'Have you considered the alternative scenario?',
        'The market seems to think otherwise.',
        'Good point about the timing.',
        'This could be a contrarian opportunity.'
      ];
      
      const content = random(comments);
      const createdAt = randomDate(post.created_at, new Date());
      
      await client.query(
        `INSERT INTO posts (user_id, content, created_at, is_comment, parent_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [user.id, content, createdAt, true, post.id]
      );
    }
    
    // Generate likes
    console.log('Generating likes...');
    for (let i = 0; i < 2000; i++) {
      const post = random(posts);
      const user = random(users);
      
      try {
        await client.query(
          'INSERT INTO likes (user_id, post_id, created_at) VALUES ($1, $2, $3)',
          [user.id, post.id, randomDate(post.created_at, new Date())]
        );
      } catch (err) {
        // Skip duplicates
      }
    }
    
    console.log('\n🎉 Database population completed successfully!');
    console.log('📊 Generated data:');
    console.log(`   👥 Users: 1000`);
    console.log(`   🔗 Follow relationships: ${follows.length}`);
    console.log(`   📅 Events: ${events.length} (existing)`);
    console.log(`   🎯 Predictions: ${predictionCount}`);
    console.log(`   💬 Posts: 500`);
    console.log(`   💭 Comments: 800`);
    console.log(`   ❤️  Likes: ~2000`);
    console.log(`   🏆 Reputation scores: calculated for all users`);
    console.log('\n✅ Ready to test leaderboards, feeds, and reputation system!');
    
  } catch (error) {
    console.error('Error populating database:', error);
    throw error;
  } finally {
    await client.end();
  }
}

// Run the script
if (require.main === module) {
  populateDatabase()
    .then(() => {
      console.log('Script completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Script failed:', error);
      process.exit(1);
    });
}

module.exports = { populateDatabase };