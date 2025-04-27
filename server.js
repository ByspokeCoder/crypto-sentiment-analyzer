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

// Helper function to check rate limits with more detailed tracking
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
          resetTime,
          waitSeconds: Math.ceil((resetTime - now) / 1000)
        };
      }
    }
    return { canMakeRequest: true };
  } catch (error) {
    console.error('Error checking rate limit:', error);
    return { canMakeRequest: true };
  }
}

// Helper function to set rate limit with attempt tracking
async function setRateLimit(resetTimestamp) {
  try {
    const rateLimitKey = 'twitter_rate_limit';
    const query = `
      INSERT INTO rate_limits (key, value, updated_at, attempts)
      VALUES ($1, $2, NOW(), 1)
      ON CONFLICT (key) 
      DO UPDATE SET 
        value = $2, 
        updated_at = NOW(),
        attempts = rate_limits.attempts + 1
    `;
    await pool.query(query, [rateLimitKey, new Date(resetTimestamp * 1000).toISOString()]);
  } catch (error) {
    console.error('Error setting rate limit:', error);
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
    
    // Check cache first with shorter duration for active development
    const cachedData = await getCachedData(formattedSymbol, 1); // Cache for 1 hour during development
    if (cachedData.length > 0) {
      console.log('Returning cached data for:', formattedSymbol);
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
        error: 'Rate limit exceeded. Please try again later.',
        resetTime: rateLimitStatus.resetTime,
        waitSeconds: rateLimitStatus.waitSeconds
      });
    }

    // Make API request
    const query = `${formattedSymbol} -is:retweet lang:en`;
    const tweets = await twitterClient.v2.search(query, {
      'tweet.fields': ['created_at'],
      'max_results': 10, // Reduced for testing
      'start_time': new Date(Date.now() - 60 * 60 * 1000).toISOString(), // Last hour
      'end_time': new Date().toISOString()
    });

    // Process hourly counts
    const hourlyData = new Map();
    const now = new Date();
    const startTime = new Date(now - 60 * 60 * 1000); // 1 hour ago

    // Initialize with zero counts
    for (let time = new Date(startTime); time <= now; time.setMinutes(time.getMinutes() + 15)) {
      hourlyData.set(new Date(time).toISOString(), 0);
    }

    // Count tweets
    if (tweets.data) {
      tweets.data.forEach(tweet => {
        const tweetTime = new Date(tweet.created_at);
        tweetTime.setMinutes(Math.floor(tweetTime.getMinutes() / 15) * 15, 0, 0);
        const timeKey = tweetTime.toISOString();
        hourlyData.set(timeKey, (hourlyData.get(timeKey) || 0) + 1);
      });
    }

    // Convert to arrays
    const sortedData = Array.from(hourlyData.entries())
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
      period: '1 hour'
    });

  } catch (error) {
    console.error('API Error:', error);
    
    if (error.code === 429) {
      // Set rate limit and return specific message
      const resetTime = error.rateLimit?.reset ? error.rateLimit.reset : Math.floor(Date.now() / 1000) + 900; // 15 minutes default
      await setRateLimit(resetTime);
      return res.status(429).json({
        error: 'Rate limit exceeded. Please try again later.',
        resetTime: new Date(resetTime * 1000).toISOString()
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