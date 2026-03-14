# Steam Review Summary MCP

An MCP (Model Context Protocol) server for analyzing and summarizing Steam game reviews.

It allows AI clients (such as LibreChat, ChatGPT Apps, Cursor, Claude Desktop, etc.) to query Steam reviews and receive structured summaries including sentiment analysis and purchase recommendations.

The server focuses on Chinese Steam reviews first, with automatic fallback to English when necessary.

## Features
- 🔍 Search Steam games by name
- 🎮 Automatically resolve Steam AppID
- 📊 Summarize Steam reviews
- 🇨🇳 Prioritize Simplified and Traditional Chinese reviews
- 🌐 Fallback to English reviews if needed
- ⭐ Steam recommendation level analysis
- 👍 Positive and negative review themes
- 📈 Recommendation score (0–100)
- 🧾 Natural language purchase recommendation
- 🔌 Compatible with MCP clients

## Endpoints

### For ChatGPT
- **MCP Server URL:** https://steam-review-summary-chatgpt-widget.junbinz.workers.dev/mcp
- **Authentication:** None

### For Other MCP Clients
- **MCP Server URL:** https://steam-review-summary-mcp.junbinz.workers.dev/mcp
- **Transport:** Streamable HTTP
- **Authentication:** None

## Deployment

This implementation is optimized for Cloudflare Workers Free.

### Highlights
- Stateless MCP over Streamable HTTP
- No Express or long-running Node server required
- KV-based caching to reduce Steam traffic
- Lower default review caps to stay within Workers limits
- JSON-based responses for simple, client-friendly transport

### Steps
1. Install Wrangler (Cloudflare CLI): `npm install -g wrangler`

2. Login: `wrangler login`

3. Create KV namespaces

    Run:

    `wrangler kv namespace create SUMMARY_CACHE`

    and

    `wrangler kv namespace create RATE_LIMIT`

    Wrangler prints something like: `id = "xxxxxxxxxxxxxxxx"`, copy those IDs.

4. Insert KV IDs into `wrangler.toml`

    Edit:

    ```
    [[kv_namespaces]]
    binding = "SUMMARY_CACHE"
    id = "REPLACE_WITH_ID"

    [[kv_namespaces]]
    binding = "RATE_LIMIT"
    id = "REPLACE_WITH_ID"
    ```

5. Deploy the worker: `wrangler deploy`