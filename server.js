require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { TwitterApi } = require('twitter-api-v2');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? false : '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Add error handling middleware
app.use((err, req, res, next) => {
  console.error('Global error handler:', {
    message: err.message,
    stack: err.stack,
    type: err.constructor.name
  });
  res.status(500).json({
    status: 'error',
    message: 'Internal server error',
    error: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

// Initialize Twitter client
const twitterClient = new TwitterApi({
  appKey: process.env.TWITTER_API_KEY,
  appSecret: process.env.TWITTER_API_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_SECRET,
});

// Initialize PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Add pool error handler
pool.on('error', (err, client) => {
  console.error('Unexpected error on idle client', err);
});

// Test database connection on startup
async function testDatabaseConnection() {
  try {
    const client = await pool.connect();
    console.log('Database connection successful');
    client.release();
  } catch (err) {
    console.error('Database connection error:', {
      message: err.message,
      code: err.code,
      stack: err.stack
    });
  }
}

testDatabaseConnection();

// Helper function to get cached data with longer cache duration
async function getCachedData(symbol, hours = 168) { // Cache for 1 week
  let client;
  try {
    client = await pool.connect();
    const query = `
      SELECT timestamp, count 
      FROM mentions 
      WHERE symbol = $1 
        AND timestamp >= NOW() - INTERVAL '${hours} hours'
      ORDER BY timestamp ASC
    `;
    const result = await client.query(query, [symbol]);
    return result.rows;
  } catch (error) {
    console.error('Error getting cached data:', {
      message: error.message,
      code: error.code,
      stack: error.stack
    });
    return [];
  } finally {
    if (client) {
      client.release();
    }
  }
}

// Helper function to calculate next reset time with exponential backoff
function calculateResetTime(attempts) {
  const baseDelay = 15 * 60; // 15 minutes base delay
  const maxDelay = 24 * 60 * 60; // Max 24 hours
  const delay = Math.min(baseDelay * Math.pow(2, attempts), maxDelay);
  return new Date(Date.now() + (delay * 1000));
}

// Helper function to get human readable duration
function getHumanReadableDuration(seconds) {
  if (seconds < 60) {
    return `${Math.ceil(seconds)} seconds`;
  } else if (seconds < 3600) {
    return `${Math.ceil(seconds / 60)} minutes`;
  } else {
    return `${Math.round(seconds / 3600 * 10) / 10} hours`;
  }
}

// Helper function to check rate limits with exponential backoff
async function checkRateLimit() {
  try {
    const rateLimitKey = 'twitter_rate_limit';
    const query = `
      SELECT value, updated_at, attempts 
      FROM rate_limits 
      WHERE key = $1
    `;
    const result = await pool.query(query, [rateLimitKey]);
    
    if (result.rows.length > 0) {
      const limit = result.rows[0];
      const resetTime = new Date(limit.value);
      const now = new Date();
      
      if (resetTime > now) {
        console.log('Rate limit in effect until:', resetTime);
        return {
          canMakeRequest: false,
          resetTime: resetTime,
          waitSeconds: Math.max(0, Math.ceil((resetTime - now) / 1000)),
          attempts: limit.attempts || 0
        };
      }
    }

    // If no rate limit found or it's expired, allow the request
    return { 
      canMakeRequest: true, 
      attempts: 0,
      resetTime: new Date(),
      waitSeconds: 0
    };
  } catch (error) {
    console.error('Error checking rate limit:', error);
    // If there's an error checking rate limit, allow the request
    return { 
      canMakeRequest: true, 
      attempts: 0,
      resetTime: new Date(),
      waitSeconds: 0
    };
  }
}

// Status endpoint to check API availability
app.get('/api/status', async (req, res) => {
  console.log('Status endpoint called at:', new Date().toISOString());
  try {
    // Check Twitter API credentials first
    console.log('Checking Twitter API credentials...');
    const credentials = {
      hasApiKey: !!process.env.TWITTER_API_KEY,
      hasApiSecret: !!process.env.TWITTER_API_SECRET,
      hasAccessToken: !!process.env.TWITTER_ACCESS_TOKEN,
      hasAccessSecret: !!process.env.TWITTER_ACCESS_SECRET
    };
    console.log('Credentials status:', credentials);

    if (!Object.values(credentials).every(Boolean)) {
      return res.status(503).json({
        status: 'error',
        message: 'Missing Twitter API credentials',
        details: credentials,
        currentTime: new Date().toISOString()
      });
    }

    // Simple database check
    try {
      console.log('Attempting simple database connection test...');
      await pool.query('SELECT NOW()');
      console.log('Database connection successful');

      // Check rate limit status but don't enforce it for status checks
      const rateLimit = await checkRateLimit();
      console.log('Rate limit status:', rateLimit);

      res.json({
        status: 'available',
        message: 'API is available for requests',
        currentTime: new Date().toISOString(),
        rateLimit: rateLimit.canMakeRequest ? 'No rate limit in effect' : `Rate limited until ${rateLimit.resetTime.toISOString()}`
      });
    } catch (dbError) {
      console.error('Database connection failed:', {
        message: dbError.message,
        code: dbError.code
      });
      return res.status(503).json({
        status: 'error',
        message: 'Database connection failed',
        error: dbError.message,
        currentTime: new Date().toISOString()
      });
    }

  } catch (error) {
    console.error('Status check error:', {
      message: error.message,
      code: error.code,
      type: error.constructor.name
    });
    res.status(500).json({
      status: 'error',
      message: 'Error during basic connectivity check',
      error: error.message,
      currentTime: new Date().toISOString()
    });
  }
});

// Clear rate limit if it exists
app.post('/api/reset-rate-limit', async (req, res) => {
  try {
    const query = `
      DELETE FROM rate_limits 
      WHERE key = 'twitter_rate_limit'
    `;
    await pool.query(query);
    res.json({ 
      status: 'success',
      message: 'Rate limit reset successful'
    });
  } catch (error) {
    console.error('Error resetting rate limit:', error);
    res.status(500).json({ 
      status: 'error',
      message: 'Failed to reset rate limit'
    });
  }
});

// Helper function to set rate limit with exponential backoff
async function setRateLimit(currentAttempts = 0) {
  try {
    const rateLimitKey = 'twitter_rate_limit';
    const nextAttempts = (currentAttempts || 0) + 1;
    const resetTime = calculateResetTime(nextAttempts);
    
    const query = `
      INSERT INTO rate_limits (key, value, updated_at, attempts)
      VALUES ($1, $2, NOW(), $3)
      ON CONFLICT (key) 
      DO UPDATE SET 
        value = $2, 
        updated_at = NOW(),
        attempts = $3
    `;
    await pool.query(query, [rateLimitKey, resetTime.toISOString(), nextAttempts]);
    return resetTime;
  } catch (error) {
    console.error('Error setting rate limit:', error);
    return new Date(Date.now() + (15 * 60 * 1000)); // Default 15 min if error
  }
}

// Initialize database with enhanced rate limits table
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mentions (
        id SERIAL PRIMARY KEY,
        symbol VARCHAR(10) NOT NULL,
        count INTEGER NOT NULL,
        timestamp TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(symbol, timestamp)
      );
      
      CREATE INDEX IF NOT EXISTS idx_mentions_symbol_timestamp 
      ON mentions(symbol, timestamp);

      CREATE TABLE IF NOT EXISTS rate_limits (
        key VARCHAR(50) PRIMARY KEY,
        value TIMESTAMP NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        attempts INTEGER DEFAULT 0
      );
    `);
    console.log('Database initialized successfully');

    // Clear any existing rate limits on startup
    await pool.query(`
      DELETE FROM rate_limits 
      WHERE key = 'twitter_rate_limit'
    `);
    console.log('Rate limits cleared on startup');
  } catch (error) {
    console.error('Error initializing database:', error);
  }
}

initializeDatabase();

// Helper function to cache new data
async function cacheData(symbol, count, timestamp) {
  const query = `
    INSERT INTO mentions (symbol, count, timestamp)
    VALUES ($1, $2, $3)
    ON CONFLICT (symbol, timestamp) 
    DO UPDATE SET count = $2
  `;
  await pool.query(query, [symbol, count, timestamp]);
}

// API endpoint to get mentions
app.get('/api/mentions', async (req, res) => {
  console.log('Mentions endpoint called with params:', req.query);
  let client;
  try {
    const symbol = req.query.symbol;
    if (!symbol) {
      return res.status(400).json({ error: 'Symbol is required' });
    }

    // Format the symbol
    const formattedSymbol = symbol.startsWith('$') ? symbol : `$${symbol}`;
    console.log('Formatted symbol:', formattedSymbol);
    
    // Check cache first
    console.log('Checking cache...');
    const cachedData = await getCachedData(formattedSymbol, 1);
    if (cachedData.length > 0) {
      console.log('Returning cached data');
      return res.json({
        timestamps: cachedData.map(d => d.timestamp),
        counts: cachedData.map(d => d.count),
        totalMentions: cachedData.reduce((sum, d) => sum + d.count, 0),
        source: 'cache',
        period: '1 hour'
      });
    }

    // Check rate limit
    console.log('Checking rate limit...');
    const rateLimitStatus = await checkRateLimit();
    if (!rateLimitStatus.canMakeRequest) {
      console.log('Rate limit in effect:', rateLimitStatus);
      return res.status(429).json({ 
        error: 'Rate limit exceeded',
        resetTime: rateLimitStatus.resetTime.toISOString(),
        waitSeconds: rateLimitStatus.waitSeconds,
        waitTime: getHumanReadableDuration(rateLimitStatus.waitSeconds),
        message: `Please wait ${getHumanReadableDuration(rateLimitStatus.waitSeconds)} before trying again.`,
        nextAttempt: rateLimitStatus.resetTime.toISOString()
      });
    }

    // Make API request
    console.log('Making Twitter API request...');
    try {
      const tweets = await twitterClient.v2.tweetCountsRecent(formattedSymbol, {
        granularity: 'hour',
        start_time: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
      });

      console.log('Twitter API response received:', {
        meta: tweets.meta,
        dataLength: tweets.data?.length
      });

      if (!tweets.data || tweets.data.length === 0) {
        return res.json({
          timestamps: [],
          counts: [],
          totalMentions: 0,
          source: 'twitter',
          period: '7 days',
          message: 'No mentions found in the last 7 days'
        });
      }

      // Process the data
      const processedData = tweets.data.map(d => ({
        timestamp: d.end,
        count: d.tweet_count
      }));

      // Cache results
      console.log('Caching results...');
      for (const dataPoint of processedData) {
        await cacheData(formattedSymbol, dataPoint.count, new Date(dataPoint.timestamp));
      }

      return res.json({
        timestamps: processedData.map(d => d.timestamp),
        counts: processedData.map(d => d.count),
        totalMentions: processedData.reduce((sum, d) => sum + d.count, 0),
        source: 'twitter',
        period: '7 days'
      });

    } catch (twitterError) {
      console.error('Twitter API Error:', {
        message: twitterError.message,
        code: twitterError.code,
        data: twitterError.data,
        stack: twitterError.stack
      });

      if (twitterError.code === 429) {
        const rateLimitStatus = await checkRateLimit();
        const resetTime = await setRateLimit(rateLimitStatus.attempts);
        const waitSeconds = Math.max(0, Math.ceil((resetTime - new Date()) / 1000));
        
        return res.status(429).json({
          error: 'Rate limit exceeded',
          resetTime: resetTime.toISOString(),
          waitSeconds: waitSeconds,
          waitTime: getHumanReadableDuration(waitSeconds),
          message: `Please wait ${getHumanReadableDuration(waitSeconds)} before trying again.`,
          nextAttempt: resetTime.toISOString()
        });
      }
      
      throw twitterError; // Let the main error handler deal with other errors
    }

  } catch (error) {
    console.error('Mentions endpoint error:', {
      message: error.message,
      code: error.code,
      data: error.data,
      stack: error.stack
    });
    
    res.status(500).json({ 
      error: 'Failed to fetch data',
      message: error.message,
      details: error.data || 'No additional details available'
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// Test endpoint for Twitter API
app.get('/api/test', async (req, res) => {
  try {
    console.log('Testing Twitter API connection...');
    
    // Check if credentials exist
    const credentials = {
      hasApiKey: !!process.env.TWITTER_API_KEY,
      hasApiSecret: !!process.env.TWITTER_API_SECRET,
      hasAccessToken: !!process.env.TWITTER_ACCESS_TOKEN,
      hasAccessSecret: !!process.env.TWITTER_ACCESS_SECRET
    };

    console.log('Credentials status:', credentials);

    // If any credentials are missing, return early
    if (!Object.values(credentials).every(Boolean)) {
      return res.status(500).json({
        success: false,
        error: 'Missing Twitter API credentials',
        credentials
      });
    }

    // Try to initialize a new client
    const testClient = new TwitterApi({
      appKey: process.env.TWITTER_API_KEY,
      appSecret: process.env.TWITTER_API_SECRET,
      accessToken: process.env.TWITTER_ACCESS_TOKEN,
      accessSecret: process.env.TWITTER_ACCESS_SECRET,
    });

    // Test search endpoint
    console.log('Testing search endpoint...');
    const testQuery = '$BTC';
    const tweets = await testClient.v2.search(testQuery, {
      'tweet.fields': ['created_at'],
      max_results: 10
    });

    res.json({
      success: true,
      credentials,
      searchEndpoint: {
        working: !!tweets.data,
        tweetsFound: tweets.data?.length || 0,
        meta: tweets.meta
      }
    });

  } catch (error) {
    console.error('Twitter API test error:', {
      message: error.message,
      code: error.code,
      data: error.data,
      stack: error.stack
    });

    res.status(500).json({
      success: false,
      error: error.message,
      code: error.code,
      type: error.constructor.name,
      details: {
        message: error.message,
        code: error.code,
        data: error.data
      }
    });
  }
});

// Simple test endpoint
app.get('/api/test-mentions', async (req, res) => {
  // Static test data
  const testData = {
    timestamps: [
      new Date(Date.now() - 6 * 3600 * 1000).toISOString(),
      new Date(Date.now() - 5 * 3600 * 1000).toISOString(),
      new Date(Date.now() - 4 * 3600 * 1000).toISOString(),
      new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
      new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
      new Date(Date.now() - 1 * 3600 * 1000).toISOString(),
      new Date().toISOString()
    ],
    counts: [10, 15, 20, 25, 30, 35, 40],
    totalMentions: 175,
    source: 'test',
    period: '6 hours'
  };

  res.json(testData);
});

// Serve static files from the React app
app.use(express.static(path.join(__dirname, 'client/build')));

// The "catchall" handler: for any request that doesn't
// match one above, send back React's index.html file.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'client/build', 'index.html'));
});

// Start server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
}); 