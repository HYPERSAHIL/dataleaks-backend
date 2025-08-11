require('dotenv').config();
const express = require('express');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { UpdateConnectionState } = require('telegram/network');
const { Pool } = require('pg');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const port = process.env.PORT || 3000;

// Validate environment variables
const requiredEnv = ['API_ID', 'API_HASH', 'SESSION_STRING', 'BOT_USERNAME', 'DATABASE_URL', 'FRONTEND_URL'];
requiredEnv.forEach(env => {
  if (!process.env[env]) {
    console.error(`Missing required environment variable: ${env}`);
    process.exit(1);
  }
});

// Security middleware
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL }));
app.use(express.json());
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests, please try again later'
}));

// Database setup with SSL enforcement
const pool = new Pool({
  connectionString: "postgresql://postgres:CKibAkgFLDAKSoxhxNdSnsMsgTkCLFmG@turntable.proxy.rlwy.net:29295/railway",
  ssl: {
    rejectUnauthorized: false,
    require: true  // Enforce SSL connection
  },
  connectionTimeoutMillis: 5000,  // Fail fast on connection issues
  idleTimeoutMillis: 30000
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
    
    // Add auto-reconnect handler
    client.addEventHandler(() => {
      console.log('Telegram disconnected! Attempting reconnect...');
      client.connect();
    }, new UpdateConnectionState(UpdateConnectionState.disconnected));
  } catch (err) {
    console.error('Telegram connection error:', err);
    process.exit(1);
  }
})();

// Initialize database with retry logic
const initializeDatabase = async () => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS requests (
          id SERIAL PRIMARY KEY,
          message TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        );
      `);
      console.log('Database initialized');
      return;
    } catch (err) {
      console.error(`Database init error (attempt ${attempt}):`, err);
      if (attempt === 3) {
        console.error('Fatal database initialization failure');
        process.exit(1);
      }
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
    }
  }
};

initializeDatabase();

// API endpoint to send messages
app.post('/api/send', async (req, res) => {
  let { message } = req.body;
  
  // Input validation
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Invalid message format' });
  }

  // Sanitize and trim message
  message = message.trim().substring(0, 500);

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
    
    // Handle specific Telegram errors
    if (error.message.includes('AUTH_KEY_UNREGISTERED')) {
      return res.status(500).json({ error: 'Invalid Telegram session. Contact support.' });
    }
    
    // Handle database connection issues
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
      return res.status(503).json({ error: 'Database unavailable. Try again later.' });
    }
    
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Improved health check
app.get('/health', async (req, res) => {
  try {
    // Test database connection
    await pool.query('SELECT 1');
    
    res.json({
      status: 'ok',
      telegram: client.connected ? 'connected' : 'disconnected',
      database: 'operational'
    });
  } catch (err) {
    res.status(500).json({
      status: 'unhealthy',
      telegram: client.connected ? 'connected' : 'disconnected',
      database: 'down',
      error: err.message
    });
  }
});

// Start server with graceful shutdown
const server = app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log(`Frontend URL: ${process.env.FRONTEND_URL}`);
});

// Graceful shutdown handling
process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...');
  
  server.close(async () => {
    console.log('HTTP server closed');
    
    // Close database pool
    await pool.end();
    console.log('Database connections closed');
    
    // Disconnect Telegram client
    await client.disconnect();
    console.log('Telegram client disconnected');
    
    process.exit(0);
  });
});
