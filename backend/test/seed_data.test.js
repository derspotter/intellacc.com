const request = require('supertest');
const app = require('../src/index'); // Assuming your Express app is exported from index.js
const db = require('../src/config/db'); // Assuming db connection pool is exported

// Use a flag to ensure seeding only runs once per test execution
let isSeeded = false;

// Increase Jest timeout for API calls and potential delays
jest.setTimeout(30000); // 30 seconds

describe('Seed Database via API', () => {

    // Ensure DB connection is closed after tests
    afterAll(async () => {
        await db.end(); // Close the database connection pool
        // If your app instance holds resources, close them too if necessary
        // e.g., if app is a server instance: app.close();
    });

    test('should seed database if not already seeded', async () => {
        if (isSeeded) {
            console.log('Database already seeded in this run.');
            return;
        }

        console.log('Starting database seeding...');

        // 1. Register Admin User
        console.log('Registering admin user...');
        const adminRegRes = await request(app)
            .post('/api/users/register')
            .send({
                username: 'admin',
                email: 'admin@example.com',
                password: 'adminpass'
            });
        expect(adminRegRes.statusCode).toBe(201); // Expect Created
        const adminUserId = adminRegRes.body.user.id; // Adjust based on your actual response structure
        console.log(`Admin user registered with ID: ${adminUserId}`);

        // 2. Register Regular User
        console.log('Registering regular user...');
        const user1RegRes = await request(app)
            .post('/api/users/register')
            .send({
                username: 'user1',
                email: 'user1@example.com',
                password: 'password123'
            });
        expect(user1RegRes.statusCode).toBe(201);
        const user1Id = user1RegRes.body.user.id; // Adjust based on your actual response structure
        console.log(`Regular user registered with ID: ${user1Id}`);

        // 3. Login as Admin to get token
        console.log('Logging in as admin...');
        const loginRes = await request(app)
            .post('/api/users/login')
            .send({
                email: 'admin@example.com',
                password: 'adminpass'
            });
        expect(loginRes.statusCode).toBe(200);
        const adminToken = loginRes.body.token; // Adjust based on your actual response structure
        expect(adminToken).toBeDefined();
        console.log('Admin logged in successfully.');

        // 4. Create Events (as Admin)
        console.log('Creating events...');
        const event1Res = await request(app)
            .post('/api/events') // Assuming POST /api/events creates an event
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
                topic_id: 1, // Assuming a topic with ID 1 exists or creating one first
                title: 'Will AI reach AGI by 2030?',
                details: 'Predict the likelihood of Artificial General Intelligence emergence.',
                closing_date: '2029-12-31T23:59:59Z' // ISO 8601 format
            });
        // Add more checks if needed, e.g., topic existence before event creation
        if (event1Res.statusCode !== 201) {
             console.error('Failed to create event 1:', event1Res.body);
        }
        expect(event1Res.statusCode).toBe(201);
        console.log('Event 1 created.');

        const event2Res = await request(app)
            .post('/api/events')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
                topic_id: 1, // Assuming a topic with ID 1 exists
                title: 'Market Cap of Tesla in 2025',
                details: 'Will Tesla market cap exceed $2 Trillion by end of 2025?',
                closing_date: '2025-12-31T23:59:59Z'
            });
        if (event2Res.statusCode !== 201) {
             console.error('Failed to create event 2:', event2Res.body);
        }
        expect(event2Res.statusCode).toBe(201);
        console.log('Event 2 created.');


        // 5. Create Posts (as Admin)
        console.log('Creating posts...');
        const post1Res = await request(app)
            .post('/api/posts') // Assuming POST /api/posts creates a post
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
                content: 'Welcome to the platform! Share your predictions.',
                // Add other required post fields if any, e.g., parent_id for comments
            });
        if (post1Res.statusCode !== 201) {
             console.error('Failed to create post 1:', post1Res.body);
        }
        expect(post1Res.statusCode).toBe(201);
        console.log('Post 1 created.');


        const post2Res = await request(app)
            .post('/api/posts')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
                content: 'What are your thoughts on the first event?',
            });
        if (post2Res.statusCode !== 201) {
             console.error('Failed to create post 2:', post2Res.body);
        }
        expect(post2Res.statusCode).toBe(201);
        console.log('Post 2 created.');

        isSeeded = true;
        console.log('Database seeding completed successfully.');
    });
});

// Dummy test to ensure Jest doesn't complain about no tests found if seeding is skipped
test('placeholder', () => {
  expect(true).toBe(true);
});

