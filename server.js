require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { TwitterApi } = require('twitter-api-v2');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

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
  }
});

// Helper function to get cached data with longer cache duration
async function getCachedData(symbol, hours = 168) { // Cache for 1 week
  try {
    const query = `
      SELECT timestamp, count 
      FROM mentions 
      WHERE symbol = $1 
        AND timestamp >= NOW() - INTERVAL '${hours} hours'
      ORDER BY timestamp ASC
    `;
    const result = await pool.query(query, [symbol]);
    return result.rows;
  } catch (error) {
    console.error('Error getting cached data:', error);
    return [];
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

// Status endpoint to check API availability
app.get('/api/status', async (req, res) => {
  try {
    // First check if database is accessible
    try {
      await pool.query('SELECT NOW()');
    } catch (dbError) {
      console.error('Database connection error:', dbError);
      return res.status(503).json({
        status: 'error',
        message: 'Database connection error',
        error: dbError.message,
        currentTime: new Date().toISOString()
      });
    }

    // Direct database query to get current rate limit status without affecting it
    const rateLimitKey = 'twitter_rate_limit';
    const query = `
      SELECT value, updated_at, attempts 
      FROM rate_limits 
      WHERE key = $1
    `;
    
    const result = await pool.query(query, [rateLimitKey]);
    const now = new Date();

    if (result.rows.length > 0) {
      const limit = result.rows[0];
      const resetTime = new Date(limit.value);
      
      if (resetTime > now) {
        const waitSeconds = Math.max(0, Math.ceil((resetTime - now) / 1000));
        return res.json({
          status: 'rate_limited',
          resetTime: resetTime.toISOString(),
          waitSeconds: waitSeconds,
          waitTime: getHumanReadableDuration(waitSeconds),
          message: `API is rate limited. Please wait ${getHumanReadableDuration(waitSeconds)} before making new requests.`,
          nextAttempt: resetTime.toISOString()
        });
      }
    }

    // Check Twitter API credentials
    const credentials = {
      hasApiKey: !!process.env.TWITTER_API_KEY,
      hasApiSecret: !!process.env.TWITTER_API_SECRET,
      hasAccessToken: !!process.env.TWITTER_ACCESS_TOKEN,
      hasAccessSecret: !!process.env.TWITTER_ACCESS_SECRET
    };

    if (!Object.values(credentials).every(Boolean)) {
      return res.status(503).json({
        status: 'error',
        message: 'Missing Twitter API credentials',
        details: credentials,
        currentTime: now.toISOString()
      });
    }

    // Check if we have cached data for a common symbol
    const btcData = await getCachedData('$BTC', 1);
    
    res.json({
      status: 'available',
      hasCachedData: btcData.length > 0,
      message: 'API is available for requests',
      cachedSymbols: btcData.length > 0 ? ['$BTC'] : [],
      currentTime: now.toISOString()
    });

  } catch (error) {
    console.error('Status check error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Error checking API status',
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      currentTime: new Date().toISOString()
    });
  }
});

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
    return { 
      canMakeRequest: true, 
      attempts: 0,
      resetTime: new Date(),
      waitSeconds: 0
    };
  } catch (error) {
    console.error('Error checking rate limit:', error);
    // Default to rate limited for safety
    const defaultResetTime = new Date(Date.now() + (15 * 60 * 1000));
    return { 
      canMakeRequest: false, 
      attempts: 0,
      resetTime: defaultResetTime,
      waitSeconds: 900
    };
  }
}

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
  const symbol = req.query.symbol;
  if (!symbol) {
    return res.status(400).json({ error: 'Symbol is required' });
  }

  try {
    // Format the symbol
    const formattedSymbol = symbol.startsWith('$') ? symbol : `$${symbol}`;
    
    // Check cache first
    const cachedData = await getCachedData(formattedSymbol, 1);
    if (cachedData.length > 0) {
      return res.json({
        timestamps: cachedData.map(d => d.timestamp),
        counts: cachedData.map(d => d.count),
        totalMentions: cachedData.reduce((sum, d) => sum + d.count, 0),
        source: 'cache',
        period: '1 hour'
      });
    }

    // Check rate limit
    const rateLimitStatus = await checkRateLimit();
    if (!rateLimitStatus.canMakeRequest) {
      return res.status(429).json({ 
        error: 'Rate limit exceeded',
        resetTime: rateLimitStatus.resetTime.toISOString(),
        waitSeconds: rateLimitStatus.waitSeconds,
        waitTime: getHumanReadableDuration(rateLimitStatus.waitSeconds),
        message: `Please wait ${getHumanReadableDuration(rateLimitStatus.waitSeconds)} before trying again.`,
        nextAttempt: rateLimitStatus.resetTime.toISOString()
      });
    }

    // Make API request with minimal query
    const query = `${formattedSymbol} -is:retweet`;
    const tweets = await twitterClient.v2.search(query, {
      'tweet.fields': ['created_at'],
      'max_results': 5, // Minimal results
      'start_time': new Date(Date.now() - 30 * 60 * 1000).toISOString(), // Last 30 minutes
      'end_time': new Date().toISOString()
    });

    // Process into 5-minute intervals
    const intervalData = new Map();
    const now = new Date();
    const startTime = new Date(now - 30 * 60 * 1000);

    // Initialize with zero counts
    for (let time = new Date(startTime); time <= now; time.setMinutes(time.getMinutes() + 5)) {
      intervalData.set(new Date(time).toISOString(), 0);
    }

    // Count tweets
    if (tweets.data) {
      tweets.data.forEach(tweet => {
        const tweetTime = new Date(tweet.created_at);
        tweetTime.setMinutes(Math.floor(tweetTime.getMinutes() / 5) * 5, 0, 0);
        const timeKey = tweetTime.toISOString();
        intervalData.set(timeKey, (intervalData.get(timeKey) || 0) + 1);
      });
    }

    // Convert to arrays
    const sortedData = Array.from(intervalData.entries())
      .sort(([a], [b]) => new Date(a) - new Date(b))
      .map(([timestamp, count]) => ({ timestamp, count }));

    // Cache results
    for (const dataPoint of sortedData) {
      await cacheData(formattedSymbol, dataPoint.count, new Date(dataPoint.timestamp));
    }

    res.json({
      timestamps: sortedData.map(d => d.timestamp),
      counts: sortedData.map(d => d.count),
      totalMentions: sortedData.reduce((sum, d) => sum + d.count, 0),
      source: 'twitter',
      period: '30 minutes'
    });

  } catch (error) {
    console.error('API Error:', error);
    
    if (error.code === 429) {
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
    
    res.status(500).json({ 
      error: 'Failed to fetch data',
      details: error.message
    });
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