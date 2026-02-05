const express = require('express');
const cors = require('cors');
const { randomUUID } = require('crypto');

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept', 'Mcp-Session-Id'],
  exposedHeaders: ['Mcp-Session-Id']
}));
app.use(express.json());

const NAPKIN_API_KEY = process.env.NAPKIN_API_KEY;
const sessions = new Map();

// MCP Protocol version
const PROTOCOL_VERSION = "2024-11-05";

// Tool definitions
const TOOLS = [
  {
    name: "generate_visual",
    description: "Generate infographics and visuals using Napkin AI. Creates mindmaps, flowcharts, timelines, comparisons, and more from text content.",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The text content to visualize. Use markdown formatting with headers and bullet points for best results."
        },
        visual_type: {
          type: "string",
          description: "Type of visual to generate",
          enum: ["mindmap", "flowchart", "timeline", "comparison", "infographic", "diagram"]
        },
        format: {
          type: "string",
          description: "Output format",
          enum: ["svg", "png"],
          default: "svg"
        }
      },
      required: ["content"]
    }
  }
];

// JSON-RPC response helper
function jsonRpcResponse(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// Handle MCP JSON-RPC requests
async function handleMcpRequest(request, sessionId) {
  const { method, params, id } = request;

  switch (method) {
    case "initialize":
      return jsonRpcResponse(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: "napkin-mcp-bridge",
          version: "1.0.0"
        }
      });

    case "notifications/initialized":
      // This is a notification, no response needed
      return null;

    case "tools/list":
      return jsonRpcResponse(id, { tools: TOOLS });

    case "tools/call":
      const { name, arguments: args } = params;
      
      if (name === "generate_visual") {
        try {
          const result = await generateNapkinVisual(args);
          return jsonRpcResponse(id, {
            content: [
              {
                type: "text",
                text: result
              }
            ]
          });
        } catch (error) {
          return jsonRpcResponse(id, {
            content: [
              {
                type: "text",
                text: `Error generating visual: ${error.message}`
              }
            ],
            isError: true
          });
        }
      }
      
      return jsonRpcError(id, -32601, `Unknown tool: ${name}`);

    case "ping":
      return jsonRpcResponse(id, {});

    default:
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
}

// Call Napkin AI API
async function generateNapkinVisual(args) {
  const { content, visual_type, format = "svg" } = args;

  const response = await fetch("https://api.napkin.ai/v1/image-generation/generate", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${NAPKIN_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      content: content,
      visual_query: visual_type || "auto",
      format: format
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Napkin API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  
  // Return the URL or content
  if (data.url) {
    return `Visual generated successfully!\n\nView your visual: ${data.url}`;
  } else if (data.generated_files && data.generated_files.length > 0) {
    return `Visual generated successfully!\n\nView your visual: ${data.generated_files[0].url}`;
  } else {
    return `Visual generation started. Status: ${data.status || 'processing'}`;
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'napkin-mcp-bridge' });
});

// MCP discovery endpoint (GET) - required for Claude.ai
app.get('/mcp', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.json({
    name: "napkin-mcp-bridge",
    version: "1.0.0",
    protocol_version: PROTOCOL_VERSION,
    capabilities: {
      tools: {}
    }
  });
});

// MCP endpoint - Streamable HTTP transport
app.post('/mcp', async (req, res) => {
  // Get or create session
  let sessionId = req.headers['mcp-session-id'];
  
  if (!sessionId) {
    sessionId = randomUUID();
  }
  
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { created: Date.now() });
  }
  
  res.setHeader('Mcp-Session-Id', sessionId);
  res.setHeader('Content-Type', 'application/json');

  try {
    const request = req.body;
    
    // Handle batch requests
    if (Array.isArray(request)) {
      const responses = [];
      for (const req of request) {
        const response = await handleMcpRequest(req, sessionId);
        if (response !== null) {
          responses.push(response);
        }
      }
      return res.json(responses);
    }
    
    // Handle single request
    const response = await handleMcpRequest(request, sessionId);
    
    if (response === null) {
      // Notification - return 204 No Content
      return res.status(204).end();
    }
    
    res.json(response);
  } catch (error) {
    console.error('MCP request error:', error);
    res.status(500).json(jsonRpcError(null, -32603, error.message));
  }
});

// SSE endpoint for compatibility
app.get('/sse', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  const sessionId = randomUUID();
  sessions.set(sessionId, { created: Date.now(), res });
  
  // Send initial endpoint event
  res.write(`event: endpoint\ndata: /mcp?sessionId=${sessionId}\n\n`);
  
  // Keep alive
  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 30000);
  
  req.on('close', () => {
    clearInterval(keepAlive);
    sessions.delete(sessionId);
  });
});

// Clean up old sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.created > 3600000) { // 1 hour
      sessions.delete(id);
    }
  }
}, 60000);

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Napkin MCP bridge running on port ${PORT}`);
  console.log(`MCP endpoint: /mcp`);
  console.log(`SSE endpoint: /sse`);
});
