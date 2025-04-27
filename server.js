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
  const query = `
    SELECT timestamp, count 
    FROM mentions 
    WHERE symbol = $1 
      AND timestamp >= NOW() - INTERVAL '${hours} hours'
    ORDER BY timestamp ASC
  `;
  const result = await pool.query(query, [symbol]);
  return result.rows;
}

// Helper function to check rate limits
async function checkRateLimit() {
  try {
    const rateLimitKey = 'twitter_rate_limit';
    const query = `
      SELECT value, updated_at 
      FROM rate_limits 
      WHERE key = $1
    `;
    const result = await pool.query(query, [rateLimitKey]);
    
    if (result.rows.length > 0) {
      const limit = result.rows[0];
      const resetTime = new Date(limit.value);
      if (resetTime > new Date()) {
        return false; // Still rate limited
      }
    }
    return true; // Not rate limited
  } catch (error) {
    console.error('Error checking rate limit:', error);
    return true; // Assume not rate limited on error
  }
}

// Helper function to set rate limit
async function setRateLimit(resetTimestamp) {
  try {
    const rateLimitKey = 'twitter_rate_limit';
    const query = `
      INSERT INTO rate_limits (key, value, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (key) 
      DO UPDATE SET value = $2, updated_at = NOW()
    `;
    await pool.query(query, [rateLimitKey, new Date(resetTimestamp * 1000).toISOString()]);
  } catch (error) {
    console.error('Error setting rate limit:', error);
  }
}

// Initialize database with rate limits table
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mentions (
        id SERIAL PRIMARY KEY,
        symbol VARCHAR(10) NOT NULL,
        count INTEGER NOT NULL,
        timestamp TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE INDEX IF NOT EXISTS idx_mentions_symbol_timestamp 
      ON mentions(symbol, timestamp);

      CREATE TABLE IF NOT EXISTS rate_limits (
        key VARCHAR(50) PRIMARY KEY,
        value TIMESTAMP NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
  console.log('Received request for mentions with query:', req.query);
  console.log('Request headers:', req.headers);
  
  const symbol = req.query.symbol;
  if (!symbol) {
    console.log('No symbol provided in request');
    return res.status(400).json({ error: 'Symbol is required' });
  }

  try {
    // Verify Twitter credentials are present
    if (!process.env.TWITTER_API_KEY || !process.env.TWITTER_API_SECRET || 
        !process.env.TWITTER_ACCESS_TOKEN || !process.env.TWITTER_ACCESS_SECRET) {
      console.error('Missing Twitter API credentials');
      return res.status(500).json({ 
        error: 'Twitter API credentials are not properly configured',
        details: 'Missing required Twitter API credentials'
      });
    }

    console.log('Twitter credentials status:', {
      hasApiKey: !!process.env.TWITTER_API_KEY,
      hasApiSecret: !!process.env.TWITTER_API_SECRET,
      hasAccessToken: !!process.env.TWITTER_ACCESS_TOKEN,
      hasAccessSecret: !!process.env.TWITTER_ACCESS_SECRET
    });
    
    // Format the symbol to ensure it starts with $
    const formattedSymbol = symbol.startsWith('$') ? symbol : `$${symbol}`;
    const symbolWithoutDollar = symbol.startsWith('$') ? symbol.substring(1) : symbol;
    
    console.log('Formatted symbol:', formattedSymbol);
    console.log('Symbol without dollar:', symbolWithoutDollar);

    // Check cache first
    const cachedData = await getCachedData(formattedSymbol);
    if (cachedData.length > 0) {
      console.log('Returning cached data for:', formattedSymbol);
      return res.json({
        timestamps: cachedData.map(d => d.timestamp),
        counts: cachedData.map(d => d.count),
        totalMentions: cachedData.reduce((sum, d) => sum + d.count, 0),
        source: 'cache',
        period: '7 days'
      });
    }

    // Check rate limit before making Twitter API call
    const canMakeRequest = await checkRateLimit();
    if (!canMakeRequest) {
      console.log('Rate limit in effect');
      return res.status(429).json({ 
        error: 'Rate limit exceeded. Please try again later.',
        cached: false
      });
    }

    // Build search query
    const query = `(${formattedSymbol} OR ${symbolWithoutDollar}) -is:retweet lang:en`;
    console.log('Fetching tweet counts for query:', query);

    try {
      const counts = await twitterClient.v2.tweetCountsRecent(query, {
        granularity: 'hour',
        start_time: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        end_time: new Date().toISOString()
      });

      console.log('Twitter API Response:', {
        hasData: !!counts.data,
        dataLength: counts.data ? counts.data.length : 0,
        meta: counts.meta
      });

      if (!counts.data || counts.data.length === 0) {
        return res.status(404).json({ 
          error: `No mentions found for ${symbolWithoutDollar}`,
          details: 'The symbol might be too new or not frequently mentioned',
          query: query
        });
      }

      // Process and cache the counts
      const sortedData = counts.data
        .sort((a, b) => new Date(a.start) - new Date(b.start));

      for (const dataPoint of sortedData) {
        await cacheData(formattedSymbol, dataPoint.tweet_count, new Date(dataPoint.start));
      }

      const response = {
        timestamps: sortedData.map(d => new Date(d.start).toISOString()),
        counts: sortedData.map(d => d.tweet_count),
        totalMentions: sortedData.reduce((sum, d) => sum + d.tweet_count, 0),
        source: 'twitter',
        period: '7 days'
      };

      res.json(response);

    } catch (twitterError) {
      console.error('Twitter API Error:', {
        message: twitterError.message,
        code: twitterError.code,
        data: twitterError.data
      });
      
      if (twitterError.code === 401) {
        return res.status(500).json({
          error: 'Twitter API authentication failed',
          details: 'Invalid credentials or token expired'
        });
      } else if (twitterError.code === 429) {
        return res.status(429).json({
          error: 'Twitter API rate limit exceeded',
          details: 'Please try again later'
        });
      } else {
        return res.status(500).json({
          error: 'Twitter API error',
          details: twitterError.message
        });
      }
    }

  } catch (error) {
    console.error('Server Error:', {
      message: error.message,
      stack: error.stack,
      response: error.response?.data
    });
    res.status(500).json({ 
      error: 'Server error occurred',
      details: error.message
    });
  }
});

// Test endpoint for Twitter API
app.get('/api/test', async (req, res) => {
  try {
    console.log('Testing Twitter API connection...');
    console.log('API Keys present:', {
      hasApiKey: !!process.env.TWITTER_API_KEY,
      hasApiSecret: !!process.env.TWITTER_API_SECRET,
      hasAccessToken: !!process.env.TWITTER_ACCESS_TOKEN,
      hasAccessSecret: !!process.env.TWITTER_ACCESS_SECRET
    });

    // Test search with a common term
    const testQuery = '$BTC';
    const tweets = await twitterClient.v2.search(testQuery, {
      'tweet.fields': ['created_at', 'text'],
      max_results: 10
    });

    res.json({
      success: true,
      credentials: {
        hasApiKey: !!process.env.TWITTER_API_KEY,
        hasApiSecret: !!process.env.TWITTER_API_SECRET,
        hasAccessToken: !!process.env.TWITTER_ACCESS_TOKEN,
        hasAccessSecret: !!process.env.TWITTER_ACCESS_SECRET
      },
      testQuery,
      tweetsFound: tweets.data ? tweets.data.length : 0,
      sampleTweet: tweets.data && tweets.data.length > 0 ? tweets.data[0].text : null
    });

  } catch (error) {
    console.error('Twitter API test error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      code: error.code,
      details: error
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