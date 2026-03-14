export interface Env {
  ASSETS: Fetcher;
  STEAM_MCP_URL: string;
}

const WIDGET_URI = "ui://widget/steam-review-widget.html";

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
};

type UpstreamToolResult = {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
};

type SearchMatch = {
  id?: string;
  appid?: number;
  name?: string;
  url?: string;
};

function jsonResponse(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    status: init?.status ?? 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init?.headers ?? {}),
    },
  });
}

function jsonRpcResult(id: unknown, result: unknown): Response {
  return jsonResponse({ jsonrpc: "2.0", id, result });
}

function jsonRpcError(id: unknown, code: number, message: string): Response {
  return jsonResponse({ jsonrpc: "2.0", id, error: { code, message } });
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("access-control-allow-headers", "content-type, authorization, mcp-session-id");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function getWidgetHtml(request: Request, env: Env): Promise<string> {
  const assetUrl = new URL("/widget/steam-review-widget.html", request.url);
  const res = await env.ASSETS.fetch(new Request(assetUrl.toString(), { method: "GET" }));
  if (!res.ok) {
    throw new Error(`Failed to load widget HTML: ${res.status}`);
  }
  return await res.text();
}

async function upstreamCall(env: Env, toolName: string, args: Record<string, unknown>): Promise<UpstreamToolResult> {
  const res = await fetch(env.STEAM_MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `upstream-${Date.now()}`,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Upstream MCP HTTP ${res.status}`);
  }

  const json = await res.json() as any;
  if (json.error) {
    throw new Error(json.error.message ?? "Upstream MCP error");
  }
  return json.result ?? {};
}

function normalizeSearchMatch(result: UpstreamToolResult): SearchMatch | null {
  const sc = result.structuredContent ?? {};
  const matchObj = sc.match;
  if (matchObj && typeof matchObj === "object") return matchObj as SearchMatch;

  const results = sc.results;
  if (Array.isArray(results) && results.length > 0 && results[0] && typeof results[0] === "object") {
    return results[0] as SearchMatch;
  }

  const text = result.content?.find((x) => x.type === "text")?.text ?? "";
  const m = /"id"\s*:\s*"steam-app:(\d+)"/.exec(text);
  if (m) return { id: `steam-app:${m[1]}`, appid: Number(m[1]) };
  return null;
}

function zhSteamLabel(text: unknown): string {
  const s = String(text ?? "");
  const map: Record<string, string> = {
    "Overwhelmingly Positive": "好评如潮",
    "Very Positive": "特别好评",
    "Mostly Positive": "多半好评",
    "Mixed": "褒贬不一",
    "Mostly Negative": "多半差评",
    "Overwhelmingly Negative": "差评如潮",
  };
  return map[s] ?? s;
}

function localizeLineToZh(text: unknown): string {
  let s = String(text ?? "");
  s = s.replace(/A large share of positive comments focus on "([^"]+)" \((\d+) highly relevant reviews\)\. Common feedback includes:\s*/g,
    '围绕「$1」的正面提及较多（$2 条高相关评论），常见反馈包括：');
  s = s.replace(/A large share of negative comments focus on "([^"]+)" \((\d+) highly relevant reviews\)\. Common feedback includes:\s*/g,
    '围绕「$1」的负面提及较多（$2 条高相关评论），常见反馈包括：');
  s = s.replace(/"Gameplay and core loop"/g, "「玩法与核心循环」");
  s = s.replace(/"Story and narrative"/g, "「剧情与叙事」");
  s = s.replace(/"Graphics and art"/g, "「画面与美术」");
  s = s.replace(/"Performance and optimization"/g, "「性能与优化」");
  s = s.replace(/"Price and value"/g, "「价格与性价比」");
  s = s.replace(/"Content volume and repetition"/g, "「内容量与重复度」");
  s = s.replace(/"Multiplayer and social experience"/g, "「联机与社交体验」");
  s = s.replace(/"Localization and translation"/g, "「本地化与翻译」");
  s = s.replace(/"Difficulty and balance"/g, "「难度与平衡」");
  s = s.replace(/"Controls and UI"/g, "「操作与 UI」");
  s = s.replace(/Strong buy signal overall\. Positive themes are more consistent and concentrated than the negative ones\./g,
    "整体非常值得考虑购买。");
  s = s.replace(/Generally recommended, but it depends on your preferences because several recurring complaints still matter\./g,
    "整体偏推荐购买，但是否适合你仍取决于个人偏好。");
  s = s.replace(/A cautious or discount-only buy\. Both strengths and weaknesses show up repeatedly in the reviews\./g,
    "更适合观望或打折时入手。");
  s = s.replace(/Not an easy full-price recommendation right now because the negative themes are too recurring and material\./g,
    "当前不太推荐原价购买。");
  return s;
}

function trimLine(text: string, max = 90): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function buildCardData(result: UpstreamToolResult): Record<string, unknown> {
  const sc = result.structuredContent ?? {};
  const steamLevels = (sc.steamLevels && typeof sc.steamLevels === "object")
    ? structuredClone(sc.steamLevels as Record<string, unknown>)
    : null;

  if (steamLevels && typeof steamLevels === "object") {
    const overall = (steamLevels as any).overall;
    const recentOverall = (steamLevels as any).recentOverall;
    const combinedSelectedDerived = (steamLevels as any).combinedSelectedDerived;
    const selectedLanguages = (steamLevels as any).selectedLanguages;

    if (overall && typeof overall === "object") overall.review_score_desc = zhSteamLabel((overall as any).review_score_desc);
    if (recentOverall && typeof recentOverall === "object") recentOverall.review_score_desc = zhSteamLabel((recentOverall as any).review_score_desc);
    if (combinedSelectedDerived && typeof combinedSelectedDerived === "object") {
      combinedSelectedDerived.reviewScoreDesc = zhSteamLabel((combinedSelectedDerived as any).reviewScoreDesc);
    }
    if (Array.isArray(selectedLanguages)) {
      for (const item of selectedLanguages) {
        if (item?.summary && typeof item.summary === "object") {
          item.summary.review_score_desc = zhSteamLabel(item.summary.review_score_desc);
        }
      }
    }
  }

  const positiveBullets = Array.isArray(sc.positiveBullets)
    ? sc.positiveBullets.map((x) => trimLine(localizeLineToZh(x))).slice(0, 3)
    : [];

  const negativeBullets = Array.isArray(sc.negativeBullets)
    ? sc.negativeBullets.map((x) => trimLine(localizeLineToZh(x))).slice(0, 3)
    : [];

  return {
    appid: sc.appid ?? null,
    score: sc.recommendationScore ?? null,
    steamLevels,
    playtimeStats: sc.playtimeStats ?? null,
    positiveBullets,
    negativeBullets,
    recommendationSummary: trimLine(localizeLineToZh(sc.recommendationSummary ?? ""), 70),
  };
}

async function handleToolCall(env: Env, id: unknown, params: any): Promise<Response> {
  const name = params?.name;
  const args = params?.arguments ?? {};

  if (name !== "steam_review_summary_card") {
    return jsonRpcError(id, -32601, `Unknown tool: ${String(name)}`);
  }

  let appid = typeof args.appid === "number" ? args.appid : undefined;

  if (!appid) {
    const game = String(args.game ?? "").trim();
    if (!game) return jsonRpcError(id, -32602, "Either game or appid is required");

    const searchResult = await upstreamCall(env, "appid_from_name", { name: game });
    const best = normalizeSearchMatch(searchResult);
    if (!best?.appid) return jsonRpcError(id, -32603, "Could not resolve appid from game name");
    appid = best.appid;
  }

  const upstream = await upstreamCall(env, "fetch", {
    id: `steam-app:${appid}`,
    languages: Array.isArray(args.languages) && args.languages.length ? args.languages : ["schinese", "tchinese"],
    outputLanguage: "zh-CN",
  });

  const card = buildCardData(upstream);

  return jsonRpcResult(id, {
    content: [],
    structuredContent: {
      card,
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));

    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return withCors(jsonResponse({
        ok: true,
        service: "steam-review-summary-chatgpt-widget-worker",
        upstream: env.STEAM_MCP_URL,
      }));
    }

    if (url.pathname === "/widget/steam-review-widget.html") {
      const res = await env.ASSETS.fetch(request);
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    }

    if (url.pathname !== "/mcp") return withCors(new Response("Not Found", { status: 404 }));
    if (request.method !== "POST") return withCors(jsonRpcError(null, -32600, "Only POST is supported on /mcp"));

    let body: JsonRpcRequest;
    try {
      body = await request.json() as JsonRpcRequest;
    } catch {
      return withCors(jsonRpcError(null, -32700, "Invalid JSON"));
    }

    const id = body?.id ?? null;
    const method = body?.method;
    const params = body?.params ?? {};

    try {
      if (method === "initialize") {
        return withCors(jsonRpcResult(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "steam-review-summary-chatgpt-widget", version: "1.0.4" },
        }));
      }

      if (method === "notifications/initialized") return withCors(new Response(null, { status: 202 }));

      if (method === "tools/list") {
        return withCors(jsonRpcResult(id, {
          tools: [
            {
              name: "steam_review_summary_card",
              title: "Steam 评测摘要卡片",
              description: "显示 Steam 评测摘要卡片。",
              inputSchema: {
                type: "object",
                properties: {
                  game: { type: "string", description: "游戏名，例如 Cities: Skylines" },
                  appid: { type: "number", description: "可选。已知 appid 时可直接填。" },
                  languages: { type: "array", items: { type: "string" }, description: "可选。默认 schinese,tchinese" }
                },
              },
              _meta: {
                ui: { resourceUri: WIDGET_URI },
                "openai/outputTemplate": WIDGET_URI,
                "openai/toolInvocation/invoking": "正在加载卡片…",
                "openai/toolInvocation/invoked": "卡片已显示",
              },
            },
          ],
        }));
      }

      if (method === "tools/call") return withCors(await handleToolCall(env, id, params));

      if (method === "resources/list") {
        return withCors(jsonRpcResult(id, {
          resources: [
            {
              uri: WIDGET_URI,
              name: "steam-review-widget",
              mimeType: "text/html;profile=mcp-app",
              description: "Steam 评测摘要卡片 UI",
            },
          ],
        }));
      }

      if (method === "resources/read") {
        const uri = params?.uri;
        if (uri !== WIDGET_URI) return withCors(jsonRpcError(id, -32602, "Unknown resource URI"));

        const html = await getWidgetHtml(request, env);
        return withCors(jsonRpcResult(id, {
          contents: [
            {
              uri: WIDGET_URI,
              mimeType: "text/html;profile=mcp-app",
              text: html,
              _meta: {
                "openai/widgetDescription": "以卡片方式展示 Steam 评测摘要、游玩时长统计和 100 分制购买推荐分。",
                "openai/widgetPrefersBorder": true,
              },
            },
          ],
        }));
      }

      return withCors(jsonRpcError(id, -32601, `Unknown method: ${String(method)}`));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Internal error";
      return withCors(jsonRpcError(id, -32603, message));
    }
  },
};
