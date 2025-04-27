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
  const [credentialsStatus, setCredentialsStatus] = useState(null);
  const [statusCheckInterval, setStatusCheckInterval] = useState(null);

  // Check API and credentials status initially
  useEffect(() => {
    checkApiStatus();
    checkCredentialsStatus();
    return () => {
      if (statusCheckInterval) {
        clearInterval(statusCheckInterval);
      }
    };
  }, []);

  const checkCredentialsStatus = async () => {
    try {
      const response = await axios.get(`${API_BASE_URL}/api/credentials-status`);
      setCredentialsStatus(response.data);
    } catch (error) {
      console.error('Error checking credentials status:', error);
      setCredentialsStatus({
        status: 'error',
        message: 'Unable to check credentials status'
      });
    }
  };

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
    setData(null);

    try {
      const response = await fetch(`${API_BASE_URL}/api/v2/mentions?symbol=${encodeURIComponent(symbol)}`);
      const result = await response.json();
      
      if (result.error) {
        setError(result.error);
      } else {
        setData(result);
      }
    } catch (err) {
      setError('Failed to fetch data. Please try again.');
      console.error('Error fetching data:', err);
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
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-4xl font-bold mb-8 text-center">Crypto Sentiment Analyzer</h1>
      
      {credentialsStatus?.status === 'error' && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded relative mb-4">
          <strong className="font-bold">Twitter API Error: </strong>
          <span className="block sm:inline">{credentialsStatus.error.message}</span>
        </div>
      )}

      {credentialsStatus?.status === 'success' && (
        <div className="bg-green-100 border border-green-400 text-green-700 px-4 py-3 rounded relative mb-4">
          <strong className="font-bold">Twitter API Connected Successfully</strong>
        </div>
      )}

      <form onSubmit={handleSubmit} className="mb-8">
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
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded relative mb-4">
          <strong className="font-bold">Error: </strong>
          <span className="block sm:inline">{error}</span>
        </div>
      )}

      {loading && (
        <div className="text-center">
          <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-gray-900 mx-auto"></div>
        </div>
      )}

      {data && !error && (
        <div className="bg-white rounded-lg shadow-lg p-6">
          <h2 className="text-2xl font-bold mb-4">Results for {symbol}</h2>
          <p className="mb-4">
            Total Mentions: <span className="font-bold">{data.totalMentions}</span>
            <br />
            Period: <span className="font-bold">{data.period}</span>
            <br />
            Source: <span className="font-bold">{data.source}</span>
          </p>
          
          {/* Add chart here */}
          {data.timestamps && data.counts && (
            <div className="h-64">
              <Line
                data={{
                  labels: data.timestamps.map(t => new Date(t).toLocaleString()),
                  datasets: [
                    {
                      label: 'Mentions',
                      data: data.counts,
                      fill: false,
                      borderColor: 'rgb(75, 192, 192)',
                      tension: 0.1
                    }
                  ]
                }}
                options={{
                  responsive: true,
                  maintainAspectRatio: false,
                  scales: {
                    y: {
                      beginAtZero: true
                    }
                  }
                }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default App; 