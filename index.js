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
          description: "Type of visual to generate (optional hint)",
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
      return null;

    case "tools/list":
      return jsonRpcResponse(id, { tools: TOOLS });

    case "tools/call":
      const { name, arguments: args } = params;
      
      if (name === "generate_visual") {
        try {
          const result = await generateNapkinVisual(args);
          
          // Handle different return types (image vs text)
          if (result.type === "image") {
            return jsonRpcResponse(id, {
              content: [
                {
                  type: "image",
                  data: result.data,
                  mimeType: result.mimeType
                }
              ]
            });
          } else if (result.type === "text") {
            return jsonRpcResponse(id, {
              content: [{ type: "text", text: result.text }]
            });
          } else {
            // Legacy string return
            return jsonRpcResponse(id, {
              content: [{ type: "text", text: result }]
            });
          }
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

// Sleep helper
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Call Napkin AI API (async with polling)
async function generateNapkinVisual(args) {
  const { content, visual_type, format = "svg" } = args;

  // Step 1: Create visual request
  const createResponse = await fetch("https://api.napkin.ai/v1/visual", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${NAPKIN_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      content: content,
      format: format,
      ...(visual_type && { visual_query: visual_type })
    })
  });

  if (!createResponse.ok) {
    const errorText = await createResponse.text();
    throw new Error(`Napkin API error (${createResponse.status}): ${errorText}`);
  }

  const createData = await createResponse.json();
  const requestId = createData.id || createData.request_id;

  if (!requestId) {
    throw new Error("No request ID returned from Napkin API");
  }

  // Step 2: Poll for completion (max 25 seconds to stay within MCP timeout)
  const maxAttempts = 12;
  const pollInterval = 2000; // 2 seconds

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await sleep(pollInterval);

    const statusResponse = await fetch(`https://api.napkin.ai/v1/visual/${requestId}/status`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${NAPKIN_API_KEY}`
      }
    });

    if (!statusResponse.ok) {
      continue; // Retry on error
    }

    const statusData = await statusResponse.json();
    const status = statusData.status;

    if (status === "completed") {
      // Get the file URL and download with auth
      let fileUrl = null;
      if (statusData.generated_files && statusData.generated_files.length > 0) {
        fileUrl = statusData.generated_files[0].url;
      } else if (statusData.url) {
        fileUrl = statusData.url;
      }
      
      if (!fileUrl) {
        return { type: "text", text: `✅ Visual completed but no download URL found. Response: ${JSON.stringify(statusData)}` };
      }

      // Download the file with auth header
      const fileResponse = await fetch(fileUrl, {
        headers: {
          "Authorization": `Bearer ${NAPKIN_API_KEY}`
        }
      });

      if (!fileResponse.ok) {
        return { type: "text", text: `✅ Visual generated but failed to download: ${fileResponse.status}. URL: ${fileUrl}` };
      }

      const contentType = fileResponse.headers.get('content-type') || 'image/png';
      const arrayBuffer = await fileResponse.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString('base64');
      
      // Return as image for MCP
      return {
        type: "image",
        data: base64,
        mimeType: contentType.split(';')[0]
      };
    } else if (status === "failed" || status === "error") {
      throw new Error(`Visual generation failed: ${statusData.error || "Unknown error"}`);
    }
    // Otherwise continue polling (status is "processing" or "pending")
  }

  throw new Error("Visual generation timed out after 24 seconds. Try a simpler prompt.");
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
    
    const response = await handleMcpRequest(request, sessionId);
    
    if (response === null) {
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
  
  res.write(`event: endpoint\ndata: /mcp?sessionId=${sessionId}\n\n`);
  
  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 30000);
  
  req.on('close', () => {
    clearInterval(keepAlive);
    sessions.delete(sessionId);
  });
});

// Clean up old sessions
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.created > 3600000) {
      sessions.delete(id);
    }
  }
}, 60000);

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Napkin MCP bridge running on port ${PORT}`);
  console.log(`MCP endpoint: /mcp`);
  console.log(`Health check: /health`);
});
