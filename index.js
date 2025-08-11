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

// Database setup with enhanced configuration
const poolConfig = {
  connectionString: "postgresql://postgres:CKibAkgFLDAKSoxhxNdSnsMsgTkCLFmG@turntable.proxy.rlwy.net:29295/railway",
  ssl: {
    rejectUnauthorized: false,
    require: true
  },
  connectionTimeoutMillis: 10000,  // Increased timeout to 10s
  idleTimeoutMillis: 60000,        // Increased idle timeout
  max: 10,                         // Limit connection pool size
  allowExitOnIdle: true
};

const pool = new Pool(poolConfig);

// Add keep-alive to prevent connection resets
pool.on('connect', (client) => {
  client.connection.stream.setKeepAlive(true, 60000); // 60s keep-alive
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

// Database initialization with robust retry logic
const initializeDatabase = async (maxAttempts = 5) => {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`Database initialization attempt ${attempt}/${maxAttempts}`);
      
      // Test connection first
      await pool.query('SELECT NOW() as current_time');
      
      // Create table if needed
      await pool.query(`
        CREATE TABLE IF NOT EXISTS requests (
          id SERIAL PRIMARY KEY,
          message TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        );
      `);
      
      console.log('Database initialized successfully');
      return true;
    } catch (err) {
      console.error(`Database init error (attempt ${attempt}):`, err.message);
      
      if (attempt === maxAttempts) {
        console.error('Fatal database initialization failure');
        return false;
      }
      
      // Exponential backoff with jitter
      const baseDelay = Math.pow(2, attempt) * 1000;
      const jitter = Math.random() * 1000;
      const delay = Math.min(baseDelay + jitter, 30000);
      
      console.log(`Retrying in ${Math.round(delay/1000)} seconds...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};

// Start database initialization but don't block server startup
initializeDatabase().then(success => {
  if (!success) {
    console.warn('Proceeding without database initialization. Some features may not work.');
  }
});

// API endpoint to send messages with database fallback
app.post('/api/send', async (req, res) => {
  let { message } = req.body;
  
  // Input validation
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Invalid message format' });
  }

  // Sanitize and trim message
  message = message.trim().substring(0, 500);

  try {
    // Try to save to database (if available)
    try {
      await pool.query(
        `INSERT INTO requests (message) VALUES ($1)`,
        [message]
      );
    } catch (dbError) {
      console.error('Database save error (proceeding to Telegram):', dbError.message);
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

// Improved health check with database verification
app.get('/health', async (req, res) => {
  try {
    // Test database connection
    const dbResult = await pool.query('SELECT NOW() as time').catch(() => null);
    
    res.json({
      status: 'ok',
      telegram: client.connected ? 'connected' : 'disconnected',
      database: dbResult ? 'operational' : 'degraded'
    });
  } catch (err) {
    res.status(500).json({
      status: 'unhealthy',
      telegram: client.connected ? 'connected' : 'disconnected',
      database: 'unavailable'
    });
  }
});

// Start server with graceful shutdown
const server = app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log(`Frontend URL: ${process.env.FRONTEND_URL}`);
});

// Graceful shutdown handling
const shutdown = async () => {
  console.log('Shutting down gracefully...');
  
  server.close(async () => {
    console.log('HTTP server closed');
    
    try {
      // Close database pool
      await pool.end();
      console.log('Database connections closed');
    } catch (err) {
      console.error('Error closing database pool:', err);
    }
    
    try {
      // Disconnect Telegram client
      await client.disconnect();
      console.log('Telegram client disconnected');
    } catch (err) {
      console.error('Error disconnecting Telegram client:', err);
    }
    
    process.exit(0);
  });
  
  // Force shutdown after timeout
  setTimeout(() => {
    console.error('Forcing shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
