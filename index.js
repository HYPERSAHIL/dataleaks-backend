require('dotenv').config();
const express = require('express');
const { TelegramClient } = require('gramjs');
const { StringSession } = require('gramjs/sessions');
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
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests, please try again later'
}));

// Database setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Telegram client setup
const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;
const session = new StringSession(process.env.SESSION_STRING);
const client = new TelegramClient(
  session,
  apiId,
  apiHash,
  {
    connectionRetries: 5,
    useWSS: true,
    baseLogger: console
  }
);

// Initialize Telegram connection
(async () => {
  try {
    console.log('Connecting to Telegram...');
    await client.connect();
    console.log('Telegram client connected successfully!');
    
    // Verify connection
    if (!client.connected) {
      console.error('Telegram connection failed');
      process.exit(1);
    }
  } catch (err) {
    console.error('Telegram connection error:', err);
    process.exit(1);
  }
})();

// Initialize database
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS requests (
        id SERIAL PRIMARY KEY,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('Database initialized');
  } catch (err) {
    console.error('Database init error:', err);
  }
})();

// API endpoint to send messages
app.post('/api/send', async (req, res) => {
  const { message } = req.body;
  
  // Input validation
  if (!message || typeof message !== 'string' || message.length > 500) {
    return res.status(400).json({ error: 'Invalid message' });
  }

  try {
    // Save to database
    await pool.query(
      `INSERT INTO requests (message) VALUES ($1)`,
      [message]
    );

    // Send to Telegram
    await client.sendMessage(process.env.BOT_USERNAME, {
      message: message
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    telegram: client.connected ? 'connected' : 'disconnected',
    database: 'operational'
  });
});

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log(`Frontend URL: ${process.env.FRONTEND_URL}`);
});
