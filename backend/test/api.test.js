const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

// Import routes and controllers
const apiRouter = require('../src/routes/api');
const authenticateJWT = require('../src/middleware/auth');

// Create Express app for testing
const app = express();
app.use(express.json());
app.use('/api', apiRouter);

// Mock JWT authentication middleware
jest.mock('../src/middleware/auth', () => {
  return (req, res, next) => {
    req.user = { userId: 1 }; // Mock authenticated user
    next();
  };
});

// Mock PostgreSQL pool
jest.mock('pg', () => {
  const mockPool = {
    query: jest.fn(),
  };
  return { Pool: jest.fn(() => mockPool) };
});

const pool = new Pool();

describe('API Routes', () => {
  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks();
  });

  describe('Base Route', () => {
    it('GET /api should return a working message', async () => {
      const res = await request(app).get('/api');
      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty('message', 'API is working!');
    });
  });

  describe('User Routes', () => {
    it('POST /api/users should create a new user', async () => {
      const mockUser = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'password123'
      };

      pool.query.mockResolvedValueOnce({
        rows: [{
          id: 1,
          username: mockUser.username,
          email: mockUser.email,
          created_at: new Date(),
          updated_at: new Date()
        }]
      });

      const res = await request(app)
        .post('/api/users')
        .send(mockUser);

      expect(res.statusCode).toBe(201);
      expect(res.body).toHaveProperty('username', mockUser.username);
      expect(res.body).toHaveProperty('email', mockUser.email);
      expect(res.body).not.toHaveProperty('password_hash');
    });

    it('POST /api/login should authenticate user and return token', async () => {
      const mockCredentials = {
        email: 'test@example.com',
        password: 'password123'
      };

      const hashedPassword = await bcrypt.hash(mockCredentials.password, 10);
      
      pool.query.mockResolvedValueOnce({
        rows: [{
          id: 1,
          email: mockCredentials.email,
          password_hash: hashedPassword
        }]
      });

      const res = await request(app)
        .post('/api/login')
        .send(mockCredentials);

      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty('token');
    });

    it('GET /api/me should return user profile when authenticated', async () => {
      pool.query.mockResolvedValueOnce({
        rows: [{
          id: 1,
          username: 'testuser',
          email: 'test@example.com'
        }]
      });

      const res = await request(app)
        .get('/api/me')
        .set('Authorization', 'Bearer fake-token');

      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty('username', 'testuser');
      expect(res.body).toHaveProperty('email', 'test@example.com');
    });
  });

  describe('Post Routes', () => {
    it('POST /api/posts should create a new post', async () => {
      const mockPost = {
        content: 'Test post content',
        image_url: 'https://example.com/image.jpg'
      };

      pool.query.mockResolvedValueOnce({
        rows: [{
          id: 1,
          user_id: 1,
          ...mockPost,
          created_at: new Date()
        }]
      });

      const res = await request(app)
        .post('/api/posts')
        .set('Authorization', 'Bearer fake-token')
        .send(mockPost);

      expect(res.statusCode).toBe(201);
      expect(res.body).toHaveProperty('content', mockPost.content);
      expect(res.body).toHaveProperty('image_url', mockPost.image_url);
    });

    it('GET /api/posts should return all posts', async () => {
      pool.query.mockResolvedValueOnce({
        rows: [
          { id: 1, content: 'Post 1', created_at: new Date() },
          { id: 2, content: 'Post 2', created_at: new Date() }
        ]
      });

      const res = await request(app)
        .get('/api/posts')
        .set('Authorization', 'Bearer fake-token');

      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.body)).toBeTruthy();
      expect(res.body).toHaveLength(2);
    });
  });

  describe('Comment Routes', () => {
    it('POST /api/posts/:postId/comments should create a new comment', async () => {
      const mockComment = {
        content: 'Test comment'
      };

      pool.query.mockResolvedValueOnce({
        rows: [{
          id: 1,
          post_id: 1,
          user_id: 1,
          content: mockComment.content,
          created_at: new Date()
        }]
      });

      const res = await request(app)
        .post('/api/posts/1/comments')
        .set('Authorization', 'Bearer fake-token')
        .send(mockComment);

      expect(res.statusCode).toBe(201);
      expect(res.body).toHaveProperty('content', mockComment.content);
    });

    it('GET /api/posts/:postId/comments should return all comments for a post', async () => {
      pool.query.mockResolvedValueOnce({
        rows: [
          { id: 1, content: 'Comment 1', created_at: new Date() },
          { id: 2, content: 'Comment 2', created_at: new Date() }
        ]
      });

      const res = await request(app)
        .get('/api/posts/1/comments')
        .set('Authorization', 'Bearer fake-token');

      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.body)).toBeTruthy();
      expect(res.body).toHaveLength(2);
    });
  });

  describe('Prediction Routes', () => {
    it('POST /api/predict should create a new prediction', async () => {
      const mockPrediction = {
        event_id: 1,
        prediction_value: 'Yes',
        confidence: 80
      };

      // Mock event query
      pool.query.mockResolvedValueOnce({
        rows: [{ title: 'Test Event' }]
      });

      // Mock prediction insert
      pool.query.mockResolvedValueOnce({
        rows: [{
          id: 1,
          user_id: 1,
          ...mockPrediction,
          created_at: new Date()
        }]
      });

      const res = await request(app)
        .post('/api/predict')
        .set('Authorization', 'Bearer fake-token')
        .send(mockPrediction);

      expect(res.statusCode).toBe(201);
      expect(res.body).toHaveProperty('prediction_value', mockPrediction.prediction_value);
      expect(res.body).toHaveProperty('confidence', mockPrediction.confidence);
    });

    it('GET /api/predictions should return user predictions', async () => {
      pool.query.mockResolvedValueOnce({
        rows: [
          { id: 1, prediction_value: 'Yes', confidence: 80, created_at: new Date() },
          { id: 2, prediction_value: 'No', confidence: 90, created_at: new Date() }
        ]
      });

      const res = await request(app)
        .get('/api/predictions')
        .set('Authorization', 'Bearer fake-token');

      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.body)).toBeTruthy();
      expect(res.body).toHaveLength(2);
    });
  });
});