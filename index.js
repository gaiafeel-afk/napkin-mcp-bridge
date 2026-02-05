const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const NAPKIN_API_KEY = process.env.NAPKIN_API_KEY;

// Health check
app.get('/mcp', (req, res) => {
  res.json({ status: 'ok', service: 'napkin-mcp-bridge' });
});

// MCP endpoint for Claude
app.post('/mcp', async (req, res) => {
  const { method, params } = req.body;
  
  try {
    // Map MCP methods to Napkin API
    let url = 'https://api.napkin.ai/v1/';
    let body = params;
    
    // Handle different MCP methods
    if (method === 'tools/list') {
      return res.json({
        result: {
          tools: [
            {
              name: 'napkin-generate-diagram',
              description: 'Generate diagrams from napkin.ai',
              inputSchema: {
                type: 'object',
                properties: {
                  prompt: { type: 'string', description: 'Diagram description' }
                }
              }
            }
          ]
        }
      });
    }
    
    if (method === 'tools/call') {
      url += 'generate';
      body = { prompt: params.arguments?.prompt };
    }
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NAPKIN_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    
    const data = await response.json();
    res.json({ result: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Napkin bridge running on ${PORT}`));