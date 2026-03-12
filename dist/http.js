import "dotenv/config";
import cors from "cors";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createSteamReviewServer } from "./server.js";
const PORT = parseInt(process.env.PORT ?? "3369", 10);
const HOST = process.env.HOST ?? "0.0.0.0";
const MCP_PATH = process.env.MCP_PATH ?? "/mcp";
async function startStreamableHTTPServer(createServerFactory) {
    const app = createMcpExpressApp({ host: HOST });
    app.use(cors());
    app.use((req, _res, next) => {
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
        next();
    });
    app.all(MCP_PATH, async (req, res) => {
        const server = createServerFactory();
        // Stateless mode is the simplest and most Inspector-friendly option for local testing.
        // A fresh server+transport is created per request, matching the pattern in your working MCP server.
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
        });
        res.on("close", () => {
            transport.close().catch(() => { });
            server.close().catch(() => { });
        });
        try {
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        }
        catch (error) {
            console.error("MCP error:", error);
            if (!res.headersSent) {
                res.status(500).json({
                    jsonrpc: "2.0",
                    error: { code: -32603, message: "Internal server error" },
                    id: null,
                });
            }
        }
    });
    app.get("/health", (_req, res) => {
        res.json({
            ok: true,
            service: "steam-review-summary-mcp",
            path: MCP_PATH,
        });
    });
    const httpServer = app.listen(PORT, HOST, (err) => {
        if (err) {
            console.error("Failed to start server:", err);
            process.exit(1);
        }
        console.log(`steam-review-summary-mcp HTTP server listening on http://${HOST}:${PORT}${MCP_PATH}`);
    });
    const shutdown = () => {
        console.log("\nShutting down...");
        httpServer.close(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}
startStreamableHTTPServer(createSteamReviewServer).catch((e) => {
    console.error(e);
    process.exit(1);
});
//# sourceMappingURL=http.js.map