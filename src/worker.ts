import {
  CACHE_TTL_SECONDS,
  DEFAULT_MAX_REVIEWS_PER_LANGUAGE,
  DEFAULT_MIN_REVIEW_COUNT_FOR_ENGLISH_FALLBACK,
  clampInt,
  normalizeLanguages,
  normalizeOutputLanguage,
  normalizeSummaryMode,
  searchSteamGames,
  summarizeSteamReviews,
} from "../self-hosted/src/review-core.js";

export interface Env {
  SUMMARY_CACHE?: KVNamespace;
}

function jsonResponse(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json; charset=utf-8", ...(init?.headers ?? {}) },
  });
}

function jsonRpcResult(id: unknown, result: unknown): Response {
  return jsonResponse({ jsonrpc: "2.0", id, result });
}

function jsonRpcError(id: unknown, code: number, message: string): Response {
  return jsonResponse({ jsonrpc: "2.0", id, error: { code, message } });
}

function toolResult(id: unknown, text: string, structuredContent: unknown): Response {
  return jsonRpcResult(id, { content: [{ type: "text", text }], structuredContent });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type, mcp-session-id, authorization",
        },
      });
    }

    if (url.pathname === "/health") {
      return jsonResponse({ ok: true, service: "steam-review-summary-worker" });
    }

    if (url.pathname !== "/mcp") return new Response("Not Found", { status: 404 });

    let body: any;
    try {
      body = await request.json();
    } catch {
      return jsonRpcError(null, -32700, "Invalid JSON");
    }

    const id = body?.id ?? null;
    const method = body?.method;
    const params = body?.params ?? {};

    try {
      if (method === "initialize") {
        return jsonRpcResult(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "steam-review-summary-worker", version: "1.1.0" },
        });
      }

      if (method === "notifications/initialized") return new Response(null, { status: 202 });

      if (method === "tools/list") {
        return jsonRpcResult(id, {
          tools: [
            {
              name: "search",
              description: "Search Steam games by name and return candidate app ids.",
              inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 10, default: 5 } }, required: ["query"] },
            },
            {
              name: "query",
              description: "Alias of search.",
              inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 10, default: 5 } }, required: ["query"] },
            },
            {
              name: "appid_from_name",
              description: "Resolve the best Steam app id from a game name.",
              inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
            },
            {
              name: "fetch",
              description: "Fetch a Steam app id and return a review summary with playtime statistics.",
              inputSchema: {
                type: "object",
                properties: {
                  id: { type: "string", description: "steam-app:<appid>" },
                  languages: { type: "array", items: { type: "string" } },
                  outputLanguage: { type: "string", enum: ["zh-CN", "en"], default: "zh-CN" },
                  summaryMode: { type: "string", enum: ["heuristic", "two-stage"], default: "heuristic" },
                  minReviewCountForEnglishFallback: { type: "integer", minimum: 1, maximum: 500, default: 50 },
                  maxReviewsPerLanguage: { type: "integer", minimum: 20, maximum: 200, default: 120 },
                },
                required: ["id"],
              },
            },
            {
              name: "summarize_steam_reviews",
              description: "Summarize Steam reviews and include playtime statistics.",
              inputSchema: {
                type: "object",
                properties: {
                  appid: { type: "integer" },
                  languages: { type: "array", items: { type: "string" } },
                  outputLanguage: { type: "string", enum: ["zh-CN", "en"], default: "zh-CN" },
                  summaryMode: { type: "string", enum: ["heuristic", "two-stage"], default: "heuristic" },
                  minReviewCountForEnglishFallback: { type: "integer", minimum: 1, maximum: 500, default: 50 },
                  maxReviewsPerLanguage: { type: "integer", minimum: 20, maximum: 200, default: 120 },
                },
                required: ["appid"],
              },
            },
          ],
        });
      }

      if (method !== "tools/call") return jsonRpcError(id, -32601, `Unknown method: ${String(method)}`);

      const name = params?.name;
      const args = params?.arguments ?? {};

      if (name === "search" || name === "query") {
        const query = String(args.query ?? "").trim();
        const limit = clampInt(args.limit ?? 5, 1, 10);
        if (!query) return jsonRpcError(id, -32602, "query is required");
        const results = await searchSteamGames(query, limit);
        return toolResult(id, JSON.stringify(results, null, 2), results);
      }

      if (name === "appid_from_name") {
        const gameName = String(args.name ?? "").trim();
        if (!gameName) return jsonRpcError(id, -32602, "name is required");
        const results = await searchSteamGames(gameName, 5);
        return toolResult(id, JSON.stringify(results[0] ?? null, null, 2), results[0] ?? null);
      }

      if (name === "fetch" || name === "summarize_steam_reviews") {
        const appid = name === "fetch"
          ? (() => {
              const m = /^steam-app:(\d+)$/.exec(String(args.id ?? "").trim());
              return m ? Number(m[1]) : NaN;
            })()
          : Number(args.appid);

        if (!Number.isInteger(appid) || appid <= 0) {
          return jsonRpcError(id, -32602, name === "fetch" ? "id must be in the form steam-app:<appid>" : "appid must be a positive integer");
        }

        const cacheKey = [
          "summary",
          appid,
          normalizeLanguages(args.languages).join(","),
          normalizeOutputLanguage(args.outputLanguage),
          normalizeSummaryMode(args.summaryMode),
          clampInt(args.minReviewCountForEnglishFallback ?? DEFAULT_MIN_REVIEW_COUNT_FOR_ENGLISH_FALLBACK, 1, 500),
          clampInt(args.maxReviewsPerLanguage ?? DEFAULT_MAX_REVIEWS_PER_LANGUAGE, 20, 200),
        ].join(":");

        let summary: any = null;
        if (env.SUMMARY_CACHE) summary = await env.SUMMARY_CACHE.get(cacheKey, "json");

        if (!summary) {
          summary = await summarizeSteamReviews({
            appid,
            languages: normalizeLanguages(args.languages),
            outputLanguage: normalizeOutputLanguage(args.outputLanguage),
            summaryMode: normalizeSummaryMode(args.summaryMode),
            minReviewCountForEnglishFallback: clampInt(args.minReviewCountForEnglishFallback ?? DEFAULT_MIN_REVIEW_COUNT_FOR_ENGLISH_FALLBACK, 1, 500),
            maxReviewsPerLanguage: clampInt(args.maxReviewsPerLanguage ?? DEFAULT_MAX_REVIEWS_PER_LANGUAGE, 20, 200),
          });
          if (env.SUMMARY_CACHE) {
            await env.SUMMARY_CACHE.put(cacheKey, JSON.stringify(summary), { expirationTtl: CACHE_TTL_SECONDS });
          }
        }

        return toolResult(id, summary.text, summary);
      }

      return jsonRpcError(id, -32601, `Unknown tool: ${String(name)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Internal error";
      return jsonRpcError(id, -32603, message);
    }
  },
};
