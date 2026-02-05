const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const http = require('http');

const app = express();
app.use(cors());
app.use(express.json());

const NAPKIN_API_KEY = process.env.NAPKIN_API_KEY;

app.get('/mcp', (req, res) => {
  res.write('Starting MCP handshake...\n');
  res.end();
});

app.post('/mcp', async (req, res) => {
  const { method, params } = req.body;
  
  try {
    const response = await fetch('https://api.napkin.ai/v1/' + method, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NAPKIN_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    });
    
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Napkin bridge running on ${PORT}`));