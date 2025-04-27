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
  try {
    const { symbol } = req.query;
    if (!symbol) {
      return res.status(400).json({ error: 'Symbol is required' });
    }

    // Format symbol and check cache first
    const formattedSymbol = symbol.startsWith('$') ? symbol : `$${symbol}`;
    const symbolWithoutDollar = symbol.startsWith('$') ? symbol.substring(1) : symbol;

    // Check cache first
    const cachedData = await getCachedData(formattedSymbol);
    if (cachedData.length > 0) {
      return res.json({
        timestamps: cachedData.map(d => d.timestamp),
        counts: cachedData.map(d => d.count),
        source: 'cache'
      });
    }

    // Check rate limit before making Twitter API call
    const canMakeRequest = await checkRateLimit();
    if (!canMakeRequest) {
      return res.status(429).json({ 
        error: 'Rate limit exceeded. Please try again later.',
        cached: false
      });
    }

    // Build search query
    const query = `(${formattedSymbol} OR ${symbolWithoutDollar}) -is:retweet lang:en`;
    console.log('Searching Twitter with query:', query);

    const tweets = await twitterClient.v2.search(query, {
      'tweet.fields': ['created_at', 'text'],
      max_results: 100
    });

    // If we get a rate limit response, store it
    if (tweets.rateLimit) {
      await setRateLimit(tweets.rateLimit.reset);
    }

    // Process tweets and store results
    if (!tweets.data || tweets.data.length === 0) {
      return res.status(404).json({ 
        error: `No mentions found for ${symbolWithoutDollar}. The symbol might be too new or not frequently mentioned.`,
        searchQuery: query
      });
    }

    const hourlyCount = new Map();
    let count = 0;

    for (const tweet of tweets.data) {
      const tweetDate = new Date(tweet.created_at);
      const hourKey = new Date(
        tweetDate.getFullYear(),
        tweetDate.getMonth(),
        tweetDate.getDate(),
        tweetDate.getHours()
      );
      
      hourlyCount.set(hourKey.toISOString(), (hourlyCount.get(hourKey.toISOString()) || 0) + 1);
      count++;
      
      // Cache the data
      await cacheData(formattedSymbol, count, hourKey);
    }

    const sortedData = Array.from(hourlyCount.entries())
      .sort(([a], [b]) => new Date(a) - new Date(b));

    res.json({
      timestamps: sortedData.map(([timestamp]) => timestamp),
      counts: sortedData.map(([, count]) => count),
      totalTweets: count,
      source: 'twitter'
    });

  } catch (error) {
    console.error('Error fetching mentions:', error);
    
    if (error.code === 429) {
      // Store rate limit info if available
      if (error.rateLimit) {
        await setRateLimit(error.rateLimit.reset);
      }
      return res.status(429).json({ 
        error: 'Rate limit exceeded. Please try again in a few minutes.',
        resetTime: error.rateLimit ? new Date(error.rateLimit.reset * 1000) : null
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to fetch data. Please try again.',
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