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
app.use(express.static(path.join(__dirname, 'client/build')));

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

    // First check cache
    const cachedData = await getCachedData(symbol);
    if (cachedData.length > 0) {
      return res.json({
        timestamps: cachedData.map(d => d.timestamp),
        counts: cachedData.map(d => d.count)
      });
    }

    // If no cached data, fetch from Twitter
    const now = new Date();
    const tweets = await twitterClient.v2.search(`${symbol} -is:retweet`);
    
    // Process tweets and count by hour
    const hourlyCount = new Map();
    let count = 0;
    
    for await (const tweet of tweets) {
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
      await cacheData(symbol, count, hourKey);
    }

    // Format data for response
    const sortedData = Array.from(hourlyCount.entries())
      .sort(([a], [b]) => new Date(a) - new Date(b));

    res.json({
      timestamps: sortedData.map(([timestamp]) => timestamp),
      counts: sortedData.map(([, count]) => count)
    });

  } catch (error) {
    console.error('Error fetching mentions:', error);
    res.status(500).json({ error: 'Failed to fetch mentions' });
  }
});

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'client/build', 'index.html'));
  });
}

// Start server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
}); 