import React, { useState } from 'react';
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

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    
    try {
      const requestUrl = `${API_BASE_URL}/api/mentions?symbol=${encodeURIComponent(symbol)}`;
      console.log('Making API request to:', requestUrl);
      console.log('Current environment:', process.env.NODE_ENV);
      console.log('API base URL:', API_BASE_URL);
      
      const response = await axios.get(requestUrl);
      console.log('API Response:', response.data);
      setData(response.data);
    } catch (err) {
      console.error('API Error details:', {
        message: err.message,
        response: err.response?.data,
        status: err.response?.status,
        headers: err.response?.headers
      });
      setError(err.response?.data?.error || 'Failed to fetch data. Please try again.');
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
          <button type="submit" disabled={loading}>
            {loading ? 'Loading...' : 'Analyze'}
          </button>
        </form>
        
        {error && <div className="error">{error}</div>}
        
        {data && (
          <div className="chart-container">
            <Line data={chartData} options={options} />
            {data.totalMentions && (
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