const express = require('express');
const cors = require('cors');
const { randomUUID } = require('crypto');
const archiver = require('archiver');

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept', 'Mcp-Session-Id'],
  exposedHeaders: ['Mcp-Session-Id']
}));
app.use(express.json());

const NAPKIN_API_KEY = process.env.NAPKIN_API_KEY;
const BASE_URL = process.env.BASE_URL || ''; // e.g., https://your-app.railway.app
const sessions = new Map();
const imageStore = new Map(); // Store generated images temporarily

// MCP Protocol version
const PROTOCOL_VERSION = "2024-11-05";

// Tool definitions
const TOOLS = [
  {
    name: "generate_visual",
    description: "Generate infographics and visuals using Napkin AI. Creates mindmaps, flowcharts, timelines, comparisons, and more from text content. Returns the image displayed inline plus a download ID for bundling.",
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
          default: "png"
        },
        filename: {
          type: "string",
          description: "Optional filename for the image (without extension)"
        }
      },
      required: ["content"]
    }
  },
  {
    name: "bundle_images",
    description: "Bundle multiple generated images into a downloadable ZIP file. Use after generating visuals with generate_visual.",
    inputSchema: {
      type: "object",
      properties: {
        image_ids: {
          type: "array",
          items: { type: "string" },
          description: "Array of image IDs returned from generate_visual calls"
        }
      },
      required: ["image_ids"]
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
          version: "1.1.0"
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
          return jsonRpcResponse(id, { content: result.content });
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
      
      if (name === "bundle_images") {
        try {
          const result = await bundleImages(args);
          return jsonRpcResponse(id, {
            content: [{ type: "text", text: result }]
          });
        } catch (error) {
          return jsonRpcResponse(id, {
            content: [
              {
                type: "text",
                text: `Error bundling images: ${error.message}`
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

// Bundle images into zip
async function bundleImages(args) {
  const { image_ids } = args;
  
  if (!image_ids || image_ids.length === 0) {
    throw new Error("No image IDs provided");
  }

  // Validate all images exist
  const images = [];
  for (const id of image_ids) {
    const img = imageStore.get(id);
    if (!img) {
      throw new Error(`Image not found: ${id}. Images expire after 1 hour.`);
    }
    images.push({ id, ...img });
  }

  // Create bundle ID
  const bundleId = randomUUID();
  
  // Store bundle reference
  imageStore.set(`bundle_${bundleId}`, {
    type: 'bundle',
    imageIds: image_ids,
    created: Date.now()
  });

  const downloadUrl = BASE_URL ? `${BASE_URL}/download/zip/${bundleId}` : `/download/zip/${bundleId}`;
  
  return `✅ Bundle created with ${images.length} images!\n\n🔗 Download ZIP: ${downloadUrl}\n\nImages included:\n${images.map((img, i) => `${i + 1}. ${img.filename}`).join('\n')}\n\n⚠️ Link expires in 1 hour.`;
}

// Call Napkin AI API (async with polling)
async function generateNapkinVisual(args) {
  const { content, visual_type, format = "png", filename } = args;

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
        return { 
          content: [{ type: "text", text: `✅ Visual completed but no download URL found. Response: ${JSON.stringify(statusData)}` }]
        };
      }

      // Download the file with auth header
      const fileResponse = await fetch(fileUrl, {
        headers: {
          "Authorization": `Bearer ${NAPKIN_API_KEY}`
        }
      });

      if (!fileResponse.ok) {
        return { 
          content: [{ type: "text", text: `✅ Visual generated but failed to download: ${fileResponse.status}. URL: ${fileUrl}` }]
        };
      }

      const contentType = fileResponse.headers.get('content-type') || 'image/png';
      const arrayBuffer = await fileResponse.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const base64 = buffer.toString('base64');
      const mimeType = contentType.split(';')[0];
      
      // Generate image ID and store
      const imageId = randomUUID().slice(0, 8);
      const ext = mimeType.includes('svg') ? 'svg' : (mimeType.includes('png') ? 'png' : 'jpg');
      const finalFilename = filename ? `${filename}.${ext}` : `napkin_${imageId}.${ext}`;
      
      imageStore.set(imageId, {
        data: buffer,
        mimeType: mimeType,
        filename: finalFilename,
        created: Date.now()
      });

      const downloadUrl = BASE_URL ? `${BASE_URL}/download/${imageId}` : `/download/${imageId}`;
      
      // Return image + text with download info
      return {
        content: [
          {
            type: "image",
            data: base64,
            mimeType: mimeType
          },
          {
            type: "text",
            text: `📎 Image ID: \`${imageId}\`\n🔗 Direct download: ${downloadUrl}\n📁 Filename: ${finalFilename}`
          }
        ]
      };
    } else if (status === "failed" || status === "error") {
      throw new Error(`Visual generation failed: ${statusData.error || "Unknown error"}`);
    }
    // Otherwise continue polling (status is "processing" or "pending")
  }

  throw new Error("Visual generation timed out after 24 seconds. Try a simpler prompt.");
}

// Download single image
app.get('/download/:id', (req, res) => {
  const { id } = req.params;
  const img = imageStore.get(id);
  
  if (!img || img.type === 'bundle') {
    return res.status(404).json({ error: 'Image not found or expired' });
  }
  
  res.setHeader('Content-Type', img.mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="${img.filename}"`);
  res.send(img.data);
});

// Download ZIP bundle
app.get('/download/zip/:bundleId', (req, res) => {
  const { bundleId } = req.params;
  const bundle = imageStore.get(`bundle_${bundleId}`);
  
  if (!bundle || bundle.type !== 'bundle') {
    return res.status(404).json({ error: 'Bundle not found or expired' });
  }
  
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="napkin_images_${bundleId.slice(0, 8)}.zip"`);
  
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(res);
  
  for (const imageId of bundle.imageIds) {
    const img = imageStore.get(imageId);
    if (img && img.type !== 'bundle') {
      archive.append(img.data, { name: img.filename });
    }
  }
  
  archive.finalize();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'napkin-mcp-bridge', storedImages: imageStore.size });
});

// MCP discovery endpoint (GET) - required for Claude.ai
app.get('/mcp', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.json({
    name: "napkin-mcp-bridge",
    version: "1.1.0",
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

// Clean up old sessions and images (1 hour expiry)
setInterval(() => {
  const now = Date.now();
  const oneHour = 3600000;
  
  for (const [id, session] of sessions) {
    if (now - session.created > oneHour) {
      sessions.delete(id);
    }
  }
  
  for (const [id, item] of imageStore) {
    if (now - item.created > oneHour) {
      imageStore.delete(id);
    }
  }
}, 60000);

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Napkin MCP bridge v1.1.0 running on port ${PORT}`);
  console.log(`MCP endpoint: /mcp`);
  console.log(`Health check: /health`);
  console.log(`Download endpoint: /download/:id`);
  console.log(`ZIP bundle: /download/zip/:bundleId`);
});
