// backend/src/controllers/userController.js

const { Pool } = require('pg');



const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Create a new user
const bcrypt = require('bcrypt');
exports.createUser = async (req, res) => {
  const { username, email, password } = req.body;  // Change "password_hash" to "password"
  try {
    const hashedPassword = await bcrypt.hash(password, 10); // Hash the password before storing
    const result = await pool.query(
      'INSERT INTO users (username, email, password_hash, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW()) RETURNING *',
      [username, email, hashedPassword]  // Save hashed password
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error creating user');
  }
};


// Get a user by ID
exports.getUser = async (req, res) => {
  const userId = req.params.id;
  try {
    const result = await pool.query('SELECT id, username, email, created_at, updated_at FROM users WHERE id = $1', [userId]);
    if (result.rows.length === 0) {
      return res.status(404).send('User not found');
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error fetching user');
  }
};

const jwt = require('jsonwebtoken');


// Login a user
exports.loginUser = async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(400).send('User not found');
    }

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);

    if (!match) {
      return res.status(400).send('Incorrect password');
    }

    const token = jwt.sign({ userId: user.id }, 'your_jwt_secret', { expiresIn: '1h' });
    res.json({ token });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error logging in');
  }
};


exports.getUserProfile = async (req, res) => {
  try {
    const userId = req.user.userId; // Extract user ID from token

    const result = await pool.query(
      "SELECT id, username, email FROM users WHERE id = $1",
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json(result.rows[0]); // Return user profile (excluding password)
  } catch (err) {
    console.error("Error fetching user profile:", err);
    res.status(500).json({ message: "Internal Server Error" });
  }
};

exports.createEvent = async (req, res) => {
  const { title, details, closing_date } = req.body;  // ✅ Change from `name` to `title`

  try {
      const result = await pool.query(
          "INSERT INTO events (title, details, closing_date) VALUES ($1, $2, $3) RETURNING *",
          [title, details, closing_date]  // ✅ Use `title` instead of `name`
      );
      res.status(201).json(result.rows[0]);
  } catch (err) {
      console.error("Error creating event:", err);
      res.status(500).send("Database error: " + err.message);
  }
};



exports.makePrediction = async (req, res) => {
  const { event_id, prediction_value, confidence } = req.body;
  const userId = req.user.userId;

  try {
      // ✅ Fetch the event title instead of "name"
      const eventQuery = await pool.query("SELECT title FROM events WHERE id = $1", [event_id]);

      if (eventQuery.rows.length === 0) {
          return res.status(400).json({ message: "Invalid event_id" });
      }

      const eventTitle = eventQuery.rows[0].title;  // ✅ Change from `name` to `title`

      // ✅ Insert prediction into database
      const result = await pool.query(
          "INSERT INTO predictions (user_id, event_id, event, prediction_value, confidence) VALUES ($1, $2, $3, $4, $5) RETURNING *",
          [userId, event_id, eventTitle, prediction_value, confidence]  // ✅ Use `eventTitle`
      );

      res.status(201).json(result.rows[0]);
  } catch (err) {
      console.error("Error saving prediction:", err);
      res.status(500).send("Database error: " + err.message);
  }
};