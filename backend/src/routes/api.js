// backend/src/routes/api.js

const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const postController = require('../controllers/postController'); // New controller for posts
const commentController = require('../controllers/commentController'); // New comment controller
const authenticateJWT = require("../middleware/auth");

// Base test route
router.get("/", (req, res) => {
    res.json({ message: "API is working!" });
});

// User Routes
router.post("/users", userController.createUser);
router.get("/users/:id", authenticateJWT, userController.getUser);
router.post('/login', userController.loginUser);
router.get("/me", authenticateJWT, userController.getUserProfile);

// Prediction/Events Routes
router.post("/predict", authenticateJWT, userController.makePrediction);
router.post("/events", authenticateJWT, userController.createEvent);
router.patch("/predictions/:id", authenticateJWT, userController.resolvePrediction);
router.get("/predictions", authenticateJWT, userController.getPredictions);

// Post Routes
router.post("/posts", authenticateJWT, postController.createPost);
router.get("/posts", authenticateJWT, postController.getPosts);                // Get all posts (or feed)
router.get("/posts/:id", authenticateJWT, postController.getPostById);           // Get a single post
router.patch("/posts/:id", authenticateJWT, postController.updatePost);          // Update a post
router.delete("/posts/:id", authenticateJWT, postController.deletePost);         // Delete a post

// Comment Routes
router.post("/posts/:postId/comments", authenticateJWT, commentController.createComment);
router.get("/posts/:postId/comments", authenticateJWT, commentController.getComments);
router.patch("/posts/:postId/comments/:commentId", authenticateJWT, commentController.updateComment);
router.delete("/posts/:postId/comments/:commentId", authenticateJWT, commentController.deleteComment);

module.exports = router;
