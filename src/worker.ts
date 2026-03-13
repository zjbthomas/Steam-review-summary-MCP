/**
 * Cloudflare Workers MCP endpoint for Steam review summaries.
 *
 * Fixes for LibreChat / Streamable HTTP usage:
 * - public endpoint by default
 * - KV caching for summaries
 * - rate limiting disabled by default
 * - if enabled, rate limit applies only to tools/call, not initialize/tools/list
 * - much higher default rate limit to avoid false positives from MCP clients
 */

export interface Env {
  SUMMARY_CACHE?: KVNamespace;
  RATE_LIMIT?: KVNamespace;
  ENABLE_RATE_LIMIT?: string;
}

type OutputLanguage = "zh-CN" | "en";
type SummaryMode = "heuristic" | "two-stage";

type SteamReview = {
  recommendationid?: string;
  review?: string;
  voted_up?: boolean;
  language?: string;
  timestamp_created?: number;
  author?: {
    playtime_at_review?: number;
    playtime_forever?: number;
  };
};

type SteamQuerySummary = {
  review_score?: number;
  review_score_desc?: string;
  total_positive?: number;
  total_negative?: number;
  total_reviews?: number;
};

type AppReviewsResponse = {
  success: 0 | 1;
  cursor?: string;
  query_summary?: SteamQuerySummary;
  reviews?: SteamReview[];
};

type SearchResult = {
  id: string;
  appid: number;
  name: string;
  url: string;
};

type SummaryRequest = {
  appid: number;
  languages?: string[];
  outputLanguage?: OutputLanguage;
  summaryMode?: SummaryMode;
  minReviewCountForEnglishFallback?: number;
  maxReviewsPerLanguage?: number;
};

const DEFAULT_LANGUAGES = ["schinese", "tchinese"];
const DEFAULT_OUTPUT_LANGUAGE: OutputLanguage = "zh-CN";
const DEFAULT_SUMMARY_MODE: SummaryMode = "heuristic";
const DEFAULT_MIN_REVIEW_COUNT_FOR_ENGLISH_FALLBACK = 50;
const DEFAULT_MAX_REVIEWS_PER_LANGUAGE = 120;
const CACHE_TTL_SECONDS = 60 * 60 * 6;
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
const RATE_LIMIT_MAX = 300;

const languageDisplayMap: Record<string, { zh: string; en: string }> = {
  schinese: { zh: "简体中文", en: "Simplified Chinese" },
  tchinese: { zh: "繁體中文", en: "Traditional Chinese" },
  english: { zh: "英语", en: "English" },
  japanese: { zh: "日语", en: "Japanese" },
  koreana: { zh: "韩语", en: "Korean" },
  french: { zh: "法语", en: "French" },
  german: { zh: "德语", en: "German" },
  spanish: { zh: "西班牙语", en: "Spanish" },
  russian: { zh: "俄语", en: "Russian" },
  brazilian: { zh: "葡萄牙语（巴西）", en: "Portuguese (Brazil)" },
};

const positiveMarkers = [
  "good", "great", "excellent", "amazing", "fun", "love", "enjoy", "worth", "beautiful", "polished",
  "推荐", "好玩", "优秀", "喜欢", "值得", "良心", "惊艳", "上头", "耐玩", "舒服", "不错", "很棒",
];

const negativeMarkers = [
  "bad", "boring", "terrible", "awful", "poor", "buggy", "broken", "crash", "stutter", "refund",
  "不推荐", "无聊", "糟糕", "垃圾", "崩溃", "闪退", "卡顿", "掉帧", "重复", "贵", "不值", "失望", "烂",
];

const topicLexicon = {
  gameplay: {
    zh: "玩法与核心循环",
    en: "Gameplay and core loop",
    keywords: ["gameplay", "combat", "battle", "mechanic", "loop", "玩法", "战斗", "机制", "手感", "打击感", "上头", "耐玩"],
  },
  story: {
    zh: "剧情与叙事",
    en: "Story and narrative",
    keywords: ["story", "plot", "narrative", "writing", "character", "剧情", "叙事", "文案", "角色", "故事"],
  },
  graphics: {
    zh: "画面与美术",
    en: "Graphics and art",
    keywords: ["graphics", "visual", "art", "animation", "style", "画面", "美术", "演出", "动画", "建模", "风格"],
  },
  performance: {
    zh: "性能与优化",
    en: "Performance and optimization",
    keywords: ["performance", "fps", "stutter", "lag", "optimization", "crash", "bug", "性能", "优化", "掉帧", "卡顿", "闪退", "崩溃", "bug"],
  },
  price: {
    zh: "价格与性价比",
    en: "Price and value",
    keywords: ["price", "value", "worth", "discount", "dlc", "价格", "性价比", "值不值", "折扣", "售价"],
  },
  content: {
    zh: "内容量与重复度",
    en: "Content volume and repetition",
    keywords: ["content", "short", "repetitive", "variety", "endgame", "grind", "内容", "流程短", "重复", "后期", "刷子", "肝", "重复度"],
  },
  multiplayer: {
    zh: "联机与社交体验",
    en: "Multiplayer and social experience",
    keywords: ["multiplayer", "coop", "co-op", "online", "matchmaking", "pvp", "联机", "匹配", "多人", "合作"],
  },
  localization: {
    zh: "本地化与翻译",
    en: "Localization and translation",
    keywords: ["translation", "localization", "subtitle", "翻译", "本地化", "字幕", "中文", "汉化"],
  },
  difficulty: {
    zh: "难度与平衡",
    en: "Difficulty and balance",
    keywords: ["difficulty", "hard", "easy", "balance", "imbalanced", "难度", "平衡", "太难", "太简单", "不平衡"],
  },
  controls: {
    zh: "操作与 UI",
    en: "Controls and UI",
    keywords: ["control", "ui", "ux", "interface", "keybind", "操作", "按键", "交互", "界面", "手柄"],
  },
} as const;

type TopicKey = keyof typeof topicLexicon;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    if (url.pathname === "/health") {
      return withCors(jsonResponse({
        ok: true,
        service: "steam-review-summary-mcp-workers",
        rateLimitEnabled: String(env.ENABLE_RATE_LIMIT ?? "").toLowerCase() === "true",
      }));
    }

    if (url.pathname !== "/mcp") {
      return withCors(new Response("Not Found", { status: 404 }));
    }

    if (request.method !== "POST") {
      return withCors(jsonRpcError(null, -32600, "Only POST is supported on /mcp"));
    }

    let body: any;
    try {
      body = await request.json();
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
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "steam-review-summary-mcp-workers",
            version: "1.0.1",
          },
        }));
      }

      if (method === "notifications/initialized") {
        return withCors(new Response(null, { status: 202 }));
      }

      if (method === "tools/list") {
        return withCors(jsonRpcResult(id, {
          tools: [
            {
              name: "search",
              description: "Search Steam games by name and return candidate app ids.",
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string" },
                  limit: { type: "integer", minimum: 1, maximum: 10, default: 5 },
                },
                required: ["query"],
              },
            },
            {
              name: "query",
              description: "Alias of search.",
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string" },
                  limit: { type: "integer", minimum: 1, maximum: 10, default: 5 },
                },
                required: ["query"],
              },
            },
            {
              name: "fetch",
              description: "Fetch a Steam app id and return a review summary.",
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
              name: "appid_from_name",
              description: "Resolve the best Steam app id from a game name.",
              inputSchema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                },
                required: ["name"],
              },
            },
            {
              name: "summarize_steam_reviews",
              description: "Summarize Steam reviews for a specific app id.",
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
        }));
      }

      if (method === "tools/call") {
        const rateResponse = await maybeApplyRateLimit(request, env);
        if (rateResponse) return withCors(rateResponse);

        const name = params?.name;
        const args = params?.arguments ?? {};

        if (name === "search" || name === "query") {
          const query = String(args.query ?? "").trim();
          const limit = clampInt(args.limit ?? 5, 1, 10);
          if (!query) return withCors(jsonRpcError(id, -32602, "query is required"));
          const results = await searchSteamGames(query, limit);
          return withCors(toolTextResult(id, JSON.stringify(results, null, 2), results));
        }

        if (name === "appid_from_name") {
          const gameName = String(args.name ?? "").trim();
          if (!gameName) return withCors(jsonRpcError(id, -32602, "name is required"));
          const results = await searchSteamGames(gameName, 5);
          const best = results[0] ?? null;
          return withCors(toolTextResult(id, JSON.stringify(best, null, 2), best));
        }

        if (name === "fetch") {
          const rawId = String(args.id ?? "").trim();
          const appid = parseSteamAppId(rawId);
          if (!appid) return withCors(jsonRpcError(id, -32602, "id must be in the form steam-app:<appid>"));
          const summary = await summarizeWithCache(env, {
            appid,
            languages: normalizeLanguages(args.languages),
            outputLanguage: normalizeOutputLanguage(args.outputLanguage),
            summaryMode: normalizeSummaryMode(args.summaryMode),
            minReviewCountForEnglishFallback: clampInt(args.minReviewCountForEnglishFallback ?? DEFAULT_MIN_REVIEW_COUNT_FOR_ENGLISH_FALLBACK, 1, 500),
            maxReviewsPerLanguage: clampInt(args.maxReviewsPerLanguage ?? DEFAULT_MAX_REVIEWS_PER_LANGUAGE, 20, 200),
          });
          return withCors(toolTextResult(id, summary.text, summary));
        }

        if (name === "summarize_steam_reviews") {
          const appid = Number(args.appid);
          if (!Number.isInteger(appid) || appid <= 0) {
            return withCors(jsonRpcError(id, -32602, "appid must be a positive integer"));
          }
          const summary = await summarizeWithCache(env, {
            appid,
            languages: normalizeLanguages(args.languages),
            outputLanguage: normalizeOutputLanguage(args.outputLanguage),
            summaryMode: normalizeSummaryMode(args.summaryMode),
            minReviewCountForEnglishFallback: clampInt(args.minReviewCountForEnglishFallback ?? DEFAULT_MIN_REVIEW_COUNT_FOR_ENGLISH_FALLBACK, 1, 500),
            maxReviewsPerLanguage: clampInt(args.maxReviewsPerLanguage ?? DEFAULT_MAX_REVIEWS_PER_LANGUAGE, 20, 200),
          });
          return withCors(toolTextResult(id, summary.text, summary));
        }

        return withCors(jsonRpcError(id, -32601, `Unknown tool: ${String(name)}`));
      }

      return withCors(jsonRpcError(id, -32601, `Unknown method: ${String(method)}`));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Internal error";
      return withCors(jsonRpcError(id, -32603, message));
    }
  },
};

async function maybeApplyRateLimit(request: Request, env: Env): Promise<Response | null> {
  const enabled = String(env.ENABLE_RATE_LIMIT ?? "").toLowerCase() === "true";
  if (!enabled || !env.RATE_LIMIT) return null;

  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const key = `rl:${ip}:${Math.floor(Date.now() / (RATE_LIMIT_WINDOW_SECONDS * 1000))}`;
  const currentRaw = await env.RATE_LIMIT.get(key);
  const current = currentRaw ? parseInt(currentRaw, 10) : 0;

  if (current >= RATE_LIMIT_MAX) {
    return jsonRpcError(null, -32029, "Too Many Requests");
  }

  await env.RATE_LIMIT.put(key, String(current + 1), {
    expirationTtl: RATE_LIMIT_WINDOW_SECONDS + 60,
  });
  return null;
}

async function summarizeWithCache(env: Env, request: SummaryRequest): Promise<any> {
  const cacheKey = [
    "summary",
    request.appid,
    (request.languages ?? DEFAULT_LANGUAGES).join(","),
    request.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE,
    request.summaryMode ?? DEFAULT_SUMMARY_MODE,
    request.minReviewCountForEnglishFallback ?? DEFAULT_MIN_REVIEW_COUNT_FOR_ENGLISH_FALLBACK,
    request.maxReviewsPerLanguage ?? DEFAULT_MAX_REVIEWS_PER_LANGUAGE,
  ].join(":");

  if (env.SUMMARY_CACHE) {
    const cached = await env.SUMMARY_CACHE.get(cacheKey, "json");
    if (cached) return cached;
  }

  const summary = await summarizeSteamReviews(request);

  if (env.SUMMARY_CACHE) {
    await env.SUMMARY_CACHE.put(cacheKey, JSON.stringify(summary), {
      expirationTtl: CACHE_TTL_SECONDS,
    });
  }

  return summary;
}

function parseSteamAppId(id: string): number | null {
  const match = /^steam-app:(\d+)$/.exec(id);
  if (!match) return null;
  const appid = Number(match[1]);
  return Number.isInteger(appid) && appid > 0 ? appid : null;
}

function normalizeLanguages(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) return [...DEFAULT_LANGUAGES];
  const cleaned = value.map((v) => String(v).trim().toLowerCase()).filter(Boolean);
  return Array.from(new Set(cleaned.length ? cleaned : DEFAULT_LANGUAGES));
}

function normalizeOutputLanguage(value: unknown): OutputLanguage {
  return value === "en" ? "en" : "zh-CN";
}

function normalizeSummaryMode(value: unknown): SummaryMode {
  return value === "two-stage" ? "two-stage" : "heuristic";
}

function clampInt(value: unknown, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

async function searchSteamGames(query: string, limit: number): Promise<SearchResult[]> {
  const url = new URL("https://store.steampowered.com/search/suggest");
  url.searchParams.set("term", query);
  url.searchParams.set("f", "games");
  url.searchParams.set("cc", "US");
  url.searchParams.set("l", "english");
  url.searchParams.set("realm", "1");

  const html = await fetchTextWithRetry(url.toString());

  const regex = /data-ds-appid="(\d+)".*?<div class="match_name">([\s\S]*?)<\/div>/g;
  const candidates: Array<{ appid: number; name: string; score: number }> = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(html)) !== null) {
    const appid = Number(match[1]);
    const rawName = match[2] ?? "";
    const name = normalizeReviewText(rawName.replace(/<[^>]+>/g, ""));
    if (!appid || !name) continue;
    candidates.push({
      appid,
      name,
      score: scoreGameName(query, name),
    });
  }

  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => ({
      id: `steam-app:${x.appid}`,
      appid: x.appid,
      name: x.name,
      url: `https://store.steampowered.com/app/${x.appid}/`,
    }));
}

function scoreGameName(query: string, candidate: string): number {
  const q = normalizeForMatch(query);
  const c = normalizeForMatch(candidate);

  if (q === c) return 1000;
  if (c.startsWith(q)) return 900;
  if (c.includes(q)) return 800;

  const qTokens = tokenSet(q);
  const cTokens = tokenSet(c);
  const sharedTokens = qTokens.filter((x) => cTokens.includes(x)).length;
  const distance = levenshtein(q, c);

  return sharedTokens * 100 - distance;
}

function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").replace(/\s+/g, " ").trim();
}

function tokenSet(text: string): string[] {
  return Array.from(new Set(text.split(" ").filter(Boolean)));
}

function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => Array<number>(cols).fill(0));

  for (let i = 0; i < rows; i += 1) {
    const row = dp[i];
    if (row) row[0] = i;
  }
  const firstRow = dp[0];
  if (firstRow) {
    for (let j = 0; j < cols; j += 1) firstRow[j] = j;
  }

  for (let i = 1; i < rows; i += 1) {
    const row = dp[i];
    const prevRow = dp[i - 1];
    if (!row || !prevRow) continue;

    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(
        (prevRow[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (prevRow[j - 1] ?? 0) + cost,
      );
    }
  }

  return dp[rows - 1]?.[cols - 1] ?? Math.max(a.length, b.length);
}

async function summarizeSteamReviews(input: SummaryRequest): Promise<any> {
  const appid = input.appid;
  const outputLanguage = input.outputLanguage ?? DEFAULT_OUTPUT_LANGUAGE;
  const summaryMode = input.summaryMode ?? DEFAULT_SUMMARY_MODE;
  const languages = normalizeLanguages(input.languages);
  const minReviewCountForEnglishFallback =
    input.minReviewCountForEnglishFallback ?? DEFAULT_MIN_REVIEW_COUNT_FOR_ENGLISH_FALLBACK;
  const maxReviewsPerLanguage =
    input.maxReviewsPerLanguage ?? DEFAULT_MAX_REVIEWS_PER_LANGUAGE;

  const overallPromise = fetchSteamSummary(appid, "all", "all");
  const recentPromise = fetchSteamSummary(appid, "all", "recent");

  const perLanguage = await Promise.all(
    languages.map((language) => fetchSteamReviewsForLanguage(appid, language, maxReviewsPerLanguage)),
  );

  let usedLanguages = [...languages];
  let selectedReviews = perLanguage.flatMap((x) => x.reviews);

  if (selectedReviews.length < minReviewCountForEnglishFallback && !usedLanguages.includes("english")) {
    const english = await fetchSteamReviewsForLanguage(appid, "english", maxReviewsPerLanguage);
    perLanguage.push(english);
    usedLanguages.push("english");
    selectedReviews = perLanguage.flatMap((x) => x.reviews);
  }

  const deduped = dedupeReviews(selectedReviews);
  const filtered = deduped.filter((r) => ((r.author?.playtime_at_review ?? 0) >= 5 || normalizeReviewText(r.review ?? "").length >= 20));
  const reviews = filtered.length >= Math.min(20, deduped.length) ? filtered : deduped;

  const overall = (await overallPromise) ?? {};
  const recent = (await recentPromise) ?? {};

  const recommendationLabelPositive = reviews.filter((r) => r.voted_up).length;
  const recommendationLabelNegative = reviews.length - recommendationLabelPositive;
  const contentPositive = reviews.filter((r) => detectSentiment(normalizeReviewText(r.review ?? "")) === "positive").length;
  const contentNegative = reviews.filter((r) => detectSentiment(normalizeReviewText(r.review ?? "")) === "negative").length;
  const contentNeutral = reviews.length - contentPositive - contentNegative;

  const positiveBullets = buildTopicSummary(reviews, outputLanguage, "positive", summaryMode, 5);
  const negativeBullets = buildTopicSummary(reviews, outputLanguage, "negative", summaryMode, 5);
  const recommendationScore = computeRecommendationScore(reviews, overall);

  const structured = {
    appid,
    outputLanguage,
    summaryMode,
    languagesRequested: languages,
    languagesUsed: usedLanguages,
    totals: {
      totalReviewsConsidered: reviews.length,
      recommendationLabelPositive,
      recommendationLabelNegative,
      contentPositive,
      contentNegative,
      contentNeutral,
    },
    steamLevels: {
      overall,
      recentOverall: recent,
      selectedLanguages: perLanguage.map((x) => ({
        language: x.language,
        summary: x.summary ?? {},
      })),
      combinedSelectedDerived: deriveSelectedLanguageSummary(perLanguage, outputLanguage),
    },
    positiveBullets: positiveBullets.length
      ? positiveBullets
      : [outputLanguage === "zh-CN" ? "未提取到足够集中的正面主题。" : "No concentrated positive theme could be extracted."],
    negativeBullets: negativeBullets.length
      ? negativeBullets
      : [outputLanguage === "zh-CN" ? "未提取到足够集中的负面主题。" : "No concentrated negative theme could be extracted."],
    recommendationScore,
    recommendationSummary: buildRecommendationSummary(
      recommendationScore,
      outputLanguage,
      positiveBullets,
      negativeBullets,
    ),
  };

  return {
    ...structured,
    text: formatStructuredText(structured),
  };
}

function dedupeReviews(reviews: SteamReview[]): SteamReview[] {
  const seen = new Set<string>();
  const out: SteamReview[] = [];
  for (const review of reviews) {
    const id = review.recommendationid;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(review);
  }
  return out;
}

function deriveSelectedLanguageSummary(
  perLanguage: Array<{ language: string; summary?: SteamQuerySummary }>,
  outputLanguage: OutputLanguage,
) {
  const positive = perLanguage.reduce((sum, x) => sum + (x.summary?.total_positive ?? 0), 0);
  const negative = perLanguage.reduce((sum, x) => sum + (x.summary?.total_negative ?? 0), 0);
  const total = positive + negative;
  if (!total) return undefined;
  const percentPositive = (positive / total) * 100;

  return {
    positive,
    negative,
    total,
    percentPositive,
    reviewScoreDesc: mapPercentToSteamDesc(percentPositive, outputLanguage),
  };
}

async function fetchSteamSummary(
  appid: number,
  language: string,
  filter: "all" | "recent",
): Promise<SteamQuerySummary | undefined> {
  const url = new URL(`https://store.steampowered.com/appreviews/${appid}`);
  url.searchParams.set("json", "1");
  url.searchParams.set("language", language);
  url.searchParams.set("filter", filter);
  url.searchParams.set("cursor", "*");
  url.searchParams.set("review_type", "all");
  url.searchParams.set("purchase_type", "all");
  url.searchParams.set("num_per_page", "20");
  url.searchParams.set("filter_offtopic_activity", "1");

  const data = await fetchJsonWithRetry<AppReviewsResponse>(url.toString());
  return data.query_summary;
}

async function fetchSteamReviewsForLanguage(
  appid: number,
  language: string,
  maxReviews: number,
): Promise<{ language: string; summary?: SteamQuerySummary; reviews: SteamReview[] }> {
  const reviews: SteamReview[] = [];
  const seen = new Set<string>();
  let cursor = "*";
  let summary: SteamQuerySummary | undefined;

  while (reviews.length < maxReviews) {
    const url = new URL(`https://store.steampowered.com/appreviews/${appid}`);
    url.searchParams.set("json", "1");
    url.searchParams.set("language", language);
    url.searchParams.set("filter", "recent");
    url.searchParams.set("cursor", cursor);
    url.searchParams.set("review_type", "all");
    url.searchParams.set("purchase_type", "all");
    url.searchParams.set("num_per_page", "100");
    url.searchParams.set("filter_offtopic_activity", "1");

    const data = await fetchJsonWithRetry<AppReviewsResponse>(url.toString());

    if (data.success !== 1) {
      throw new Error(`Steam returned success=0 for language=${language}`);
    }

    if (!summary && data.query_summary) {
      summary = data.query_summary;
    }

    const pageReviews = data.reviews ?? [];
    if (!pageReviews.length) break;

    for (const review of pageReviews) {
      const recommendationid = review.recommendationid;
      if (!recommendationid || seen.has(recommendationid)) continue;
      seen.add(recommendationid);
      reviews.push({
        ...review,
        language,
        review: normalizeReviewText(review.review ?? ""),
      });
      if (reviews.length >= maxReviews) break;
    }

    const nextCursor = data.cursor?.trim();
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;

    await sleep(80);
  }

  return { language, summary, reviews };
}

async function fetchJsonWithRetry<T>(url: string, retries = 3): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort("timeout"), 8000);

      const response = await fetch(url, {
        headers: {
          "user-agent": "steam-review-summary-mcp-workers/1.0",
          "accept": "application/json",
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.status === 429 || response.status >= 500) {
        throw new Error(`Upstream status ${response.status}`);
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
      if (attempt >= retries) break;
      await sleep(250 * Math.pow(2, attempt));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("fetchJsonWithRetry failed");
}

async function fetchTextWithRetry(url: string, retries = 3): Promise<string> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort("timeout"), 8000);

      const response = await fetch(url, {
        headers: {
          "user-agent": "steam-review-summary-mcp-workers/1.0",
          "accept": "text/html,application/xhtml+xml",
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.status === 429 || response.status >= 500) {
        throw new Error(`Upstream status ${response.status}`);
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt >= retries) break;
      await sleep(250 * Math.pow(2, attempt));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("fetchTextWithRetry failed");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeReviewText(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function countMatches(text: string, tokens: readonly string[]): number {
  const lower = text.toLowerCase();
  let count = 0;
  for (const token of tokens) {
    if (lower.includes(token.toLowerCase())) count += 1;
  }
  return count;
}

function detectSentiment(text: string): "positive" | "negative" | "neutral" {
  const pos = countMatches(text, positiveMarkers);
  const neg = countMatches(text, negativeMarkers);
  if (pos > neg) return "positive";
  if (neg > pos) return "negative";
  return "neutral";
}

function detectTopics(text: string): TopicKey[] {
  const lower = text.toLowerCase();
  const matched: TopicKey[] = [];

  for (const key of Object.keys(topicLexicon) as TopicKey[]) {
    const info = topicLexicon[key];
    if (info.keywords.some((kw) => lower.includes(kw.toLowerCase()))) {
      matched.push(key);
    }
  }

  return matched.length ? matched : ["gameplay"];
}

function buildTopicSummary(
  reviews: SteamReview[],
  outputLanguage: OutputLanguage,
  sentiment: "positive" | "negative",
  summaryMode: SummaryMode,
  maxBullets: number,
): string[] {
  const topicCounts: Record<string, { count: number; examples: string[] }> = {};

  for (const review of reviews) {
    const clean = normalizeReviewText(review.review ?? "");
    if (!clean) continue;

    const detected = detectSentiment(clean);
    if (detected !== sentiment) continue;

    const topics = detectTopics(clean);
    for (const topic of topics) {
      topicCounts[topic] ??= { count: 0, examples: [] };
      topicCounts[topic].count += 1;
      if (topicCounts[topic].examples.length < (summaryMode === "two-stage" ? 3 : 2)) {
        topicCounts[topic].examples.push(clean.slice(0, summaryMode === "two-stage" ? 100 : 80).replace(/\s+/g, " ").trim());
      }
    }
  }

  const sorted = Object.entries(topicCounts)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, maxBullets);

  return sorted.map(([topic, data]) => {
    const info = topicLexicon[topic as TopicKey];
    const label = info ? (outputLanguage === "zh-CN" ? info.zh : info.en) : topic;
    const examples = data.examples.join(" / ");

    if (outputLanguage === "zh-CN") {
      return summaryMode === "two-stage"
        ? `「${label}」是最常见的${sentiment === "positive" ? "优点" : "缺点"}之一，共出现于 ${data.count} 条高相关评论中。代表性反馈包括：${examples}`
        : `围绕「${label}」的${sentiment === "positive" ? "正面" : "负面"}提及较多（${data.count} 条高相关评论），常见反馈包括：${examples}`;
    }

    return summaryMode === "two-stage"
      ? `"${label}" is one of the most recurring ${sentiment} themes, appearing in ${data.count} highly relevant reviews. Representative feedback includes: ${examples}`
      : `A large share of ${sentiment} comments focus on "${label}" (${data.count} highly relevant reviews). Common feedback includes: ${examples}`;
  });
}

function computeRecommendationScore(
  reviews: SteamReview[],
  overallSummary: SteamQuerySummary | undefined,
): number {
  const total = reviews.length;
  if (!total) return 0;

  const contentPositive = reviews.filter((r) => detectSentiment(normalizeReviewText(r.review ?? "")) === "positive").length;
  const contentNegative = reviews.filter((r) => detectSentiment(normalizeReviewText(r.review ?? "")) === "negative").length;

  const contentScore = safePercent(contentPositive, Math.max(1, contentPositive + contentNegative));
  const steamOverallTotal = overallSummary?.total_reviews ?? 0;
  const steamOverallPositive = overallSummary?.total_positive ?? 0;
  const steamScore = steamOverallTotal ? safePercent(steamOverallPositive, steamOverallTotal) : 50;
  const reviewVolumeBonus = clampNumber(Math.log10(total + 1) * 8, 0, 18);
  const mixedPenalty = contentNegative > contentPositive ? 12 : 0;

  return Math.round(clampNumber(contentScore * 0.6 + steamScore * 0.3 + reviewVolumeBonus - mixedPenalty, 0, 100));
}

function buildRecommendationSummary(
  score: number,
  outputLanguage: OutputLanguage,
  positiveBullets: string[],
  negativeBullets: string[],
): string {
  if (outputLanguage === "zh-CN") {
    if (score >= 85) {
      return `整体非常值得考虑购买。正面讨论明显多于负面讨论，优势点也较集中，主要体现在：${positiveBullets[0] ?? "核心体验稳定"}`;
    }
    if (score >= 70) {
      return `整体偏推荐购买，但建议结合个人偏好判断。优点比较明确，不过也存在一些会影响体验的槽点，例如：${negativeBullets[0] ?? "部分体验不够稳定"}`;
    }
    if (score >= 55) {
      return "更适合观望或打折时入手。评论中优缺点都比较突出，是否值得买取决于你是否在意它的主要问题。";
    }
    return "当前不太推荐原价购买。负面反馈较集中，且关键问题会直接影响较大一部分玩家的体验。";
  }

  if (score >= 85) return "Strong buy signal overall. Positive themes are more consistent and concentrated than the negative ones.";
  if (score >= 70) return "Generally recommended, but it depends on your preferences because several recurring complaints still matter.";
  if (score >= 55) return "A cautious or discount-only buy. Both strengths and weaknesses show up repeatedly in the reviews.";
  return "Not an easy full-price recommendation right now because the negative themes are too recurring and material.";
}

function formatStructuredText(result: any): string {
  const isZh = result.outputLanguage === "zh-CN";
  const overall = result.steamLevels.overall ?? {};
  const recent = result.steamLevels.recentOverall ?? {};

  const selectedLanguageLines = (result.steamLevels.selectedLanguages ?? []).map((item: any) => {
    const info = languageDisplayMap[item.language as string];
    const label = info ? (isZh ? info.zh : info.en) : item.language;
    const desc = item.summary?.review_score_desc ?? (isZh ? "无" : "N/A");
    const total = item.summary?.total_reviews ?? 0;
    const pos = item.summary?.total_positive ?? 0;
    const neg = item.summary?.total_negative ?? 0;
    return isZh
      ? `- ${label}: ${desc}（总计 ${total}，好评 ${pos}，差评 ${neg}）`
      : `- ${label}: ${desc} (total ${total}, positive ${pos}, negative ${neg})`;
  });

  const usedLangText = (result.languagesUsed ?? []).map((lang: string) => {
    const info = languageDisplayMap[lang];
    return info ? (isZh ? info.zh : info.en) : lang;
  }).join(isZh ? "、" : ", ");

  const combined = result.steamLevels.combinedSelectedDerived;
  const combinedLine = combined
    ? isZh
      ? `- 所选语言合并后的推导结果: ${combined.reviewScoreDesc}（总计 ${combined.total}，好评率 ${combined.percentPositive.toFixed(1)}%）`
      : `- Derived combined result across selected languages: ${combined.reviewScoreDesc} (total ${combined.total}, positive rate ${combined.percentPositive.toFixed(1)}%)`
    : "";

  return [
    `# ${isZh ? "Steam 评论摘要" : "Steam Review Summary"}`,
    "",
    `## ${isZh ? "Steam 原始推荐级别" : "Steam recommendation levels"}`,
    isZh
      ? `- 全部语言总体: ${overall.review_score_desc ?? "无"}（总计 ${overall.total_reviews ?? 0}，好评 ${overall.total_positive ?? 0}，差评 ${overall.total_negative ?? 0}）`
      : `- Overall across all languages: ${overall.review_score_desc ?? "N/A"} (total ${overall.total_reviews ?? 0}, positive ${overall.total_positive ?? 0}, negative ${overall.total_negative ?? 0})`,
    isZh
      ? `- 全部语言近期: ${recent.review_score_desc ?? "无"}（总计 ${recent.total_reviews ?? 0}，好评 ${recent.total_positive ?? 0}，差评 ${recent.total_negative ?? 0}）`
      : `- Recent across all languages: ${recent.review_score_desc ?? "N/A"} (total ${recent.total_reviews ?? 0}, positive ${recent.total_positive ?? 0}, negative ${recent.total_negative ?? 0})`,
    ...selectedLanguageLines,
    ...(combinedLine ? [combinedLine] : []),
    "",
    `## ${isZh ? "本次分析范围" : "Analysis coverage"}`,
    isZh ? `- 实际纳入分析的评论数: ${result.totals.totalReviewsConsidered}` : `- Reviews analyzed: ${result.totals.totalReviewsConsidered}`,
    isZh ? `- 实际使用语言: ${usedLangText}` : `- Languages used: ${usedLangText}`,
    isZh
      ? `- Steam 推荐标记统计: 好评 ${result.totals.recommendationLabelPositive} / 差评 ${result.totals.recommendationLabelNegative}`
      : `- Steam recommendation labels: positive ${result.totals.recommendationLabelPositive} / negative ${result.totals.recommendationLabelNegative}`,
    isZh
      ? `- 按评论文本判断的倾向: 正面 ${result.totals.contentPositive} / 负面 ${result.totals.contentNegative} / 中性 ${result.totals.contentNeutral}`
      : `- Content-based sentiment: positive ${result.totals.contentPositive} / negative ${result.totals.contentNegative} / neutral ${result.totals.contentNeutral}`,
    "",
    `## ${isZh ? "正面反馈摘要" : "Positive review summary"}`,
    ...(result.positiveBullets ?? []).map((x: string) => `- ${x}`),
    "",
    `## ${isZh ? "负面反馈摘要" : "Negative review summary"}`,
    ...(result.negativeBullets ?? []).map((x: string) => `- ${x}`),
    "",
    `## ${isZh ? "购买推荐分" : "Buy recommendation score"}`,
    `- ${result.recommendationScore}/100`,
    "",
    `## ${isZh ? "结论" : "Conclusion"}`,
    result.recommendationSummary ?? "",
  ].join("\n");
}

function mapPercentToSteamDesc(percentPositive: number, outputLanguage: OutputLanguage): string {
  const zh =
    percentPositive >= 95 ? "好评如潮"
    : percentPositive >= 80 ? "特别好评"
    : percentPositive >= 70 ? "多半好评"
    : percentPositive >= 40 ? "褒贬不一"
    : percentPositive >= 20 ? "多半差评"
    : "差评如潮";

  const en =
    percentPositive >= 95 ? "Overwhelmingly Positive"
    : percentPositive >= 80 ? "Very Positive"
    : percentPositive >= 70 ? "Mostly Positive"
    : percentPositive >= 40 ? "Mixed"
    : percentPositive >= 20 ? "Mostly Negative"
    : "Overwhelmingly Negative";

  return outputLanguage === "zh-CN" ? zh : en;
}

function safePercent(pos: number, total: number): number {
  if (!total) return 0;
  return (pos / total) * 100;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toolTextResult(id: unknown, text: string, structuredContent: unknown): Response {
  return jsonRpcResult(id, {
    content: [
      {
        type: "text",
        text,
      },
    ],
    structuredContent,
  });
}

function jsonRpcResult(id: unknown, result: unknown): Response {
  return jsonResponse({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function jsonRpcError(id: unknown, code: number, message: string): Response {
  return jsonResponse({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
}

function jsonResponse(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    status: init?.status ?? 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers ?? {}),
    },
  });
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("access-control-allow-headers", "content-type, mcp-session-id, authorization");
  headers.set("cache-control", "no-store");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
