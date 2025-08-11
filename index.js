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
const requiredEnv = ['API_ID', 'API_HASH', 'SESSION_STRING', 'BOT_USERNAME', 'FRONTEND_URL'];
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

// Database setup using Railway's internal connection
const pool = new Pool({
  user: 'postgres',
  password: 'CKibAkgFLDAKSoxhxNdSnsMsgTkCLFmG',
  host: 'postgres.railway.internal',
  database: 'railway',
  port: 5432,
  connectionTimeoutMillis: 5000,  // Shorter timeout
  idleTimeoutMillis: 30000,
  max: 5,                         // Smaller pool size
  allowExitOnIdle: true
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
    baseLogger: console,
    autoReconnect: true
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
  }
})();

// Database initialization
(async () => {
  try {
    console.log('Initializing database...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS requests (
        id SERIAL PRIMARY KEY,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('Database initialized successfully');
  } catch (err) {
    console.error('Database init error:', err.message);
    console.warn('Proceeding without database initialization. Some features may not work.');
  }
})();

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
    // Save to database if possible
    try {
      await pool.query(
        `INSERT INTO requests (message) VALUES ($1)`,
        [message]
      );
    } catch (dbError) {
      console.error('Database save error:', dbError.message);
    }

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
    
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    // Test database connection
    const dbStatus = await pool.query('SELECT 1')
      .then(() => 'operational')
      .catch(() => 'degraded');
    
    res.json({
      status: 'ok',
      telegram: client.connected ? 'connected' : 'disconnected',
      database: dbStatus
    });
  } catch (err) {
    res.status(500).json({
      status: 'unhealthy',
      telegram: client.connected ? 'connected' : 'disconnected',
      database: 'unavailable'
    });
  }
});

// Start server
const server = app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log(`Frontend URL: ${process.env.FRONTEND_URL}`);
});

// Graceful shutdown
const shutdown = () => {
  console.log('Shutting down gracefully...');
  
  server.close(() => {
    console.log('HTTP server closed');
    
    pool.end(() => {
      console.log('Database connections closed');
      process.exit(0);
    });
  });

  setTimeout(() => {
    console.error('Forcing shutdown after timeout');
    process.exit(1);
  }, 5000);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
