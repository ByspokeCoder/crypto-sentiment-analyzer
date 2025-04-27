import React, { useState, useEffect } from 'react';
import { Line } from 'react-chartjs-2';
import axios from 'axios';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
} from 'chart.js';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
);

// Get the base URL for API calls
const API_BASE_URL = process.env.NODE_ENV === 'production' 
  ? '' // Empty string means same domain
  : 'http://localhost:5000'; // Development server

function App() {
  const [symbol, setSymbol] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [apiStatus, setApiStatus] = useState(null);
  const [statusCheckInterval, setStatusCheckInterval] = useState(null);

  // Check API status initially and when rate limited
  useEffect(() => {
    checkApiStatus();
    return () => {
      if (statusCheckInterval) {
        clearInterval(statusCheckInterval);
      }
    };
  }, []);

  const checkApiStatus = async () => {
    try {
      const response = await axios.get(`${API_BASE_URL}/api/status`);
      setApiStatus(response.data);
      
      // If rate limited, schedule next check
      if (response.data.status === 'rate_limited') {
        // Check again 10 seconds after the reset time
        const resetTime = new Date(response.data.resetTime);
        const now = new Date();
        const waitMs = resetTime - now + 10000; // Add 10 seconds buffer
        
        if (waitMs > 0) {
          if (statusCheckInterval) {
            clearInterval(statusCheckInterval);
          }
          const interval = setInterval(checkApiStatus, waitMs);
          setStatusCheckInterval(interval);
        }
      } else {
        // Clear any existing interval if API is available
        if (statusCheckInterval) {
          clearInterval(statusCheckInterval);
          setStatusCheckInterval(null);
        }
      }
    } catch (error) {
      console.error('Error checking API status:', error);
      setApiStatus({
        status: 'error',
        message: 'Unable to check API status'
      });
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    
    try {
      // Use test endpoint first
      const response = await axios.get(`${API_BASE_URL}/api/test-mentions`);
      setData(response.data);
    } catch (err) {
      console.error('API Error:', err.message);
      setError('Failed to fetch data. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const chartData = {
    labels: data?.timestamps || [],
    datasets: [
      {
        label: 'Mentions',
        data: data?.counts || [],
        borderColor: 'rgb(75, 192, 192)',
        tension: 0.1
      }
    ]
  };

  const options = {
    responsive: true,
    plugins: {
      legend: {
        position: 'top',
      },
      title: {
        display: true,
        text: `Mentions of ${symbol} on X.com`
      }
    },
    scales: {
      y: {
        beginAtZero: true,
        title: {
          display: true,
          text: 'Number of Mentions'
        }
      },
      x: {
        title: {
          display: true,
          text: 'Time'
        }
      }
    }
  };

  return (
    <div className="App">
      <header>
        <h1>Crypto Sentiment Analyzer</h1>
        {apiStatus && (
          <div className={`api-status ${apiStatus.status}`}>
            <p>{apiStatus.message}</p>
            {apiStatus.status === 'rate_limited' && (
              <>
                <p>Next attempt available: {new Date(apiStatus.nextAttempt).toLocaleTimeString()}</p>
                <p className="status-note">(Status updates automatically)</p>
              </>
            )}
            {apiStatus.status === 'available' && (
              <p className="status-note">Ready to analyze crypto mentions</p>
            )}
          </div>
        )}
      </header>
      <main>
        <form onSubmit={handleSubmit}>
          <input
            type="text"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            placeholder="Enter crypto symbol (e.g., $ETH)"
            required
          />
          <button 
            type="submit" 
            disabled={loading || (apiStatus?.status === 'rate_limited')}
          >
            {loading ? 'Loading...' : 'Analyze'}
          </button>
        </form>
        
        {error && (
          <div className="error">
            <p>{error.message}</p>
            {error.waitTime && (
              <p>Next attempt available at: {new Date(error.nextAttempt).toLocaleTimeString()}</p>
            )}
          </div>
        )}
        
        {data && (
          <div className="chart-container">
            <Line data={chartData} options={options} />
            {data.totalMentions !== undefined && (
              <div className="stats">
                <p>Total mentions: {data.totalMentions}</p>
                <p>Data source: {data.source}</p>
                <p>Time period: {data.period}</p>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

export default App; 