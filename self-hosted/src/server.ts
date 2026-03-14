import "dotenv/config";
import express from "express";
import cors from "cors";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  DEFAULT_MAX_REVIEWS_PER_LANGUAGE,
  DEFAULT_MIN_REVIEW_COUNT_FOR_ENGLISH_FALLBACK,
  clampInt,
  normalizeLanguages,
  normalizeOutputLanguage,
  normalizeSummaryMode,
  searchSteamGames,
  summarizeSteamReviews,
} from "./review-core.js";

function searchResultsPayload(results: Awaited<ReturnType<typeof searchSteamGames>>) {
  return { results };
}

function appidPayload(best: Awaited<ReturnType<typeof searchSteamGames>>[number] | null) {
  return best ? { match: best } : {};
}

export function createSteamReviewServer(): McpServer {
  const server = new McpServer({ name: "steam-review-summary-selfhost", version: "1.1.1" });

  server.registerTool("search", {
    title: "Search Steam games",
    description: "Search Steam games by name and return candidate app ids.",
    inputSchema: { query: z.string(), limit: z.number().int().min(1).max(10).default(5) },
  }, async ({ query, limit }) => {
    const results = await searchSteamGames(query, limit);
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      structuredContent: searchResultsPayload(results),
    };
  });

  server.registerTool("query", {
    title: "Query Steam games",
    description: "Alias of search.",
    inputSchema: { query: z.string(), limit: z.number().int().min(1).max(10).default(5) },
  }, async ({ query, limit }) => {
    const results = await searchSteamGames(query, limit);
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      structuredContent: searchResultsPayload(results),
    };
  });

  server.registerTool("appid_from_name", {
    title: "Resolve Steam appid",
    description: "Resolve the best Steam app id from a game name.",
    inputSchema: { name: z.string() },
  }, async ({ name }) => {
    const results = await searchSteamGames(name, 5);
    const best = results[0] ?? null;
    return {
      content: [{ type: "text", text: JSON.stringify(best, null, 2) }],
      structuredContent: appidPayload(best),
    };
  });

  const summarySchema = {
    appid: z.number().int().positive(),
    languages: z.array(z.string()).optional(),
    outputLanguage: z.enum(["zh-CN", "en"]).optional(),
    summaryMode: z.enum(["heuristic", "two-stage"]).optional(),
    minReviewCountForEnglishFallback: z.number().int().min(1).max(500).optional(),
    maxReviewsPerLanguage: z.number().int().min(20).max(300).optional(),
  };

  server.registerTool("summarize_steam_reviews", {
    title: "Summarize Steam reviews",
    description: "Summarize Steam reviews and include playtime statistics.",
    inputSchema: summarySchema,
  }, async (args) => {
    const summary = await summarizeSteamReviews({
      appid: args.appid,
      languages: normalizeLanguages(args.languages),
      outputLanguage: normalizeOutputLanguage(args.outputLanguage),
      summaryMode: normalizeSummaryMode(args.summaryMode),
      minReviewCountForEnglishFallback: args.minReviewCountForEnglishFallback ?? DEFAULT_MIN_REVIEW_COUNT_FOR_ENGLISH_FALLBACK,
      maxReviewsPerLanguage: args.maxReviewsPerLanguage ?? DEFAULT_MAX_REVIEWS_PER_LANGUAGE,
    });
    return {
      content: [{ type: "text", text: summary.text }],
      structuredContent: summary,
    };
  });

  server.registerTool("fetch", {
    title: "Fetch Steam summary",
    description: "Fetch a Steam app id and return a review summary with playtime statistics.",
    inputSchema: {
      id: z.string(),
      languages: z.array(z.string()).optional(),
      outputLanguage: z.enum(["zh-CN", "en"]).optional(),
      summaryMode: z.enum(["heuristic", "two-stage"]).optional(),
      minReviewCountForEnglishFallback: z.number().int().min(1).max(500).optional(),
      maxReviewsPerLanguage: z.number().int().min(20).max(300).optional(),
    },
  }, async (args) => {
    const m = /^steam-app:(\d+)$/.exec(args.id);
    if (!m) {
      return {
        isError: true,
        content: [{ type: "text", text: "id must be in the form steam-app:<appid>" }],
      };
    }

    const summary = await summarizeSteamReviews({
      appid: Number(m[1]),
      languages: normalizeLanguages(args.languages),
      outputLanguage: normalizeOutputLanguage(args.outputLanguage),
      summaryMode: normalizeSummaryMode(args.summaryMode),
      minReviewCountForEnglishFallback: args.minReviewCountForEnglishFallback ?? DEFAULT_MIN_REVIEW_COUNT_FOR_ENGLISH_FALLBACK,
      maxReviewsPerLanguage: args.maxReviewsPerLanguage ?? DEFAULT_MAX_REVIEWS_PER_LANGUAGE,
    });
    return {
      content: [{ type: "text", text: summary.text }],
      structuredContent: summary,
    };
  });

  return server;
}

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const HOST = process.env.HOST ?? "0.0.0.0";
const MCP_PATH = process.env.MCP_PATH ?? "/mcp";

async function main() {
  const app = createMcpExpressApp({ host: HOST });
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "steam-review-summary-selfhost" });
  });

  app.all(MCP_PATH, async (req, res) => {
    const server = createSteamReviewServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.listen(PORT, HOST, () => {
    console.log(`steam-review-summary-selfhost listening on http://${HOST}:${PORT}${MCP_PATH}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
