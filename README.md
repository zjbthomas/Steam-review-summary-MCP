# Steam Review Summary MCP

An MCP (Model Context Protocol) server that analyzes and summarizes Steam game reviews.

It allows AI clients (such as LibreChat, ChatGPT Apps, Cursor, Claude Desktop, etc.) to query Steam reviews and receive structured summaries including sentiment analysis and purchase recommendations.

The server focuses on Chinese Steam reviews first, with automatic fallback to English when necessary.

**Features:**
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

## Usage

- MCP Server URL: https://175.178.11.87/steam-review-summary-mcp
- Transport: Streamable HTTP
- Authentication: No

> **Note:** ChatGPT currently cannot connect to this MCP Server because it does not support IP-based endpoints; a domain-hosted version compatible with ChatGPT connectors is under development.