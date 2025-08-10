require('dotenv').config();
const express = require('express');
const { Client } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Pool } = require('pg');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const port = process.env.PORT || 3000;

// Security middleware
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting (100 requests per 15 minutes per IP)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests, please try again later'
});
app.use(limiter);

// Database setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Telegram client setup
const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;
const session = new StringSession(process.env.SESSION_STRING || '');
const client = new Client(session, apiId, apiHash, { connectionRetries: 5 });

// Initialize Telegram connection
(async () => {
  await client.start({
    phoneNumber: process.env.PHONE_NUMBER,
    password: async () => process.env.TELEGRAM_PASSWORD || '',
    phoneCode: async () => process.env.CODE || '',
    onError: (err) => console.error('Telegram error:', err),
  });
  console.log('Telegram client connected');
})();

// Secure endpoint to send message to Telegram
app.post('/api/send', async (req, res) => {
  const { userId, message } = req.body;
  
  // Input validation
  if (!userId || !message || typeof message !== 'string' || message.length > 500) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  try {
    // Save to database
    const dbRes = await pool.query(
      `INSERT INTO requests (user_id, message) 
       VALUES ($1, $2) RETURNING id`,
      [userId, message]
    );

    // Send to Telegram
    await client.sendMessage(process.env.BOT_USERNAME, {
      message: `[${dbRes.rows[0].id}] ${message.substring(0, 490)}`
    });

    res.json({ success: true, requestId: dbRes.rows[0].id });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create tables on startup
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS requests (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('Database initialized');
  } catch (err) {
    console.error('Database init error:', err);
  }
})();

app.listen(port, () => {
  console.log(`Backend running on port ${port}`);
});
