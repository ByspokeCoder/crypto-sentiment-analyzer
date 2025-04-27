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

// Initialize database
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
    `);
    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
  }
}

initializeDatabase();

// Helper function to get cached data
async function getCachedData(symbol, hours = 24) {
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

    // Format symbol to ensure it starts with $ and handle both formats
    const formattedSymbol = symbol.startsWith('$') ? symbol : `$${symbol}`;
    const symbolWithoutDollar = symbol.startsWith('$') ? symbol.substring(1) : symbol;

    // First check cache
    const cachedData = await getCachedData(formattedSymbol);
    if (cachedData.length > 0) {
      return res.json({
        timestamps: cachedData.map(d => d.timestamp),
        counts: cachedData.map(d => d.count)
      });
    }

    // Build a more flexible search query
    const query = `(${formattedSymbol} OR ${symbolWithoutDollar}) -is:retweet lang:en`;
    console.log('Searching Twitter with query:', query);

    const tweets = await twitterClient.v2.search(query, {
      'tweet.fields': ['created_at', 'text'],
      max_results: 100
    });

    console.log('Twitter API response:', {
      dataExists: !!tweets.data,
      count: tweets.data ? tweets.data.length : 0
    });

    if (!tweets.data || tweets.data.length === 0) {
      return res.status(404).json({ 
        error: `No mentions found for ${symbolWithoutDollar}. The symbol might be too new or not frequently mentioned.`,
        searchQuery: query
      });
    }

    // Process tweets and count by hour
    const hourlyCount = new Map();
    let count = 0;

    for (const tweet of tweets.data) {
      console.log('Processing tweet:', {
        text: tweet.text.substring(0, 100),
        created_at: tweet.created_at
      });

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

    // Format data for response
    const sortedData = Array.from(hourlyCount.entries())
      .sort(([a], [b]) => new Date(a) - new Date(b));

    if (sortedData.length === 0) {
      return res.status(404).json({ 
        error: `Found tweets but couldn't process time data for ${symbolWithoutDollar}.`,
        searchQuery: query
      });
    }

    res.json({
      timestamps: sortedData.map(([timestamp]) => timestamp),
      counts: sortedData.map(([, count]) => count),
      totalTweets: count,
      searchQuery: query
    });

  } catch (error) {
    console.error('Error fetching mentions:', error);
    
    // Provide more specific error messages
    if (error.code === 429) {
      return res.status(429).json({ error: 'Rate limit exceeded. Please try again later.' });
    } else if (error.code === 401) {
      return res.status(401).json({ error: 'Authentication error with Twitter API.' });
    } else if (error.code === 'ECONNREFUSED') {
      return res.status(503).json({ error: 'Cannot connect to Twitter API. Please try again later.' });
    }
    
    res.status(500).json({ 
      error: 'Failed to fetch data. Please try again.',
      details: error.message,
      searchQuery: query
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