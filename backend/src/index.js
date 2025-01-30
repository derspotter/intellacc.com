// backend/src/index.js

const express = require('express');
const { Pool } = require('pg');

const app = express();
const port = process.env.NODE_PORT || 3000;

// PostgreSQL Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});


// Middleware
app.use(express.json());

// Example Route
app.get('/', async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW()');
    res.send(`Intellacc Backend Running. Database Time: ${result.rows[0].now}`);
    client.release();
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// Additional Routes
app.use('/api', require('./routes/api'));

app.listen(port, () => {
  console.log(`Intellacc Backend running on port ${port}`);
});
