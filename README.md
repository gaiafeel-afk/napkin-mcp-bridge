# Napkin MCP Bridge

## Quick Deploy to Railway (Recommended for MCP)

1. Push this folder to GitHub
2. Go to https://railway.app
3. "New Project" → "Deploy from GitHub repo"
4. Add environment variable: `NAPKIN_API_KEY` = your Napkin key
5. Deploy

Your URL will be: `https://your-project.railway.app/mcp`

## Alternative: Run Locally with ngrok

```bash
cd ~/napkin-bridge
npm install
npm start
```

In another terminal:
```bash
ngrok http 3000
```

Use the ngrok URL in Claude Web.

## Add to Claude Web

URL: `https://your-deployed-url.com/mcp`