import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type SteamLanguageCode =
  | "schinese"
  | "tchinese"
  | "english"
  | "japanese"
  | "koreana"
  | "french"
  | "german"
  | "spanish"
  | "russian"
  | "brazilian"
  | "all"
  | string;

type SteamReview = {
  recommendationid: string;
  review: string;
  timestamp_created: number;
  timestamp_updated: number;
  voted_up: boolean;
  votes_up: number;
  votes_funny: number;
  weighted_vote_score: string;
  author?: {
    playtime_forever?: number;
    playtime_last_two_weeks?: number;
    playtime_at_review?: number;
  };
  language?: string;
};

type SteamQuerySummary = {
  num_reviews?: number;
  review_score?: number;
  review_score_desc?: string;
  total_positive?: number;
  total_negative?: number;
  total_reviews?: number;
};

type AppReviewsResponse = {
  success: 1 | 0;
  cursor?: string;
  query_summary?: SteamQuerySummary;
  reviews?: SteamReview[];
};

type SearchItem = {
  id: string;
  appid: number;
  name: string;
  score: number;
};

type SteamSummaryResult = {
  appid: number;
  languagesRequested: string[];
  languagesUsed: string[];
  outputLanguage: "zh-CN" | "en";
  summaryMode: "heuristic" | "two-stage";
  totals: {
    totalReviewsConsidered: number;
    recommendationLabelPositive: number;
    recommendationLabelNegative: number;
    contentPositive: number;
    contentNegative: number;
    contentNeutral: number;
  };
  steamLevels: {
    overall: SteamQuerySummary;
    recentOverall: SteamQuerySummary;
    selectedLanguages: Array<{
      language: string;
      summary: SteamQuerySummary;
    }>;
    combinedSelectedDerived?: {
      positive: number;
      negative: number;
      total: number;
      percentPositive: number;
      reviewScoreDesc: string;
    };
  };
  positiveBullets: string[];
  negativeBullets: string[];
  recommendationScore: number;
  recommendationSummary: string;
};

const DEFAULT_LANGUAGES = ["schinese", "tchinese"];
const DEFAULT_OUTPUT_LANGUAGE = "zh-CN" as const;
const DEFAULT_SUMMARY_MODE = "two-stage" as const;
const DEFAULT_MIN_REVIEW_COUNT_FOR_ENGLISH_FALLBACK = 50;
const DEFAULT_MAX_REVIEWS_PER_LANGUAGE = 300;
const DEFAULT_RECENT_DAY_RANGE = 30;
const DEFAULT_SEARCH_LIMIT = 5;

const REQUEST_TIMEOUT_MS = 20_000;
const REQUEST_RETRY_COUNT = 4;
const REQUEST_RETRY_BASE_DELAY_MS = 800;

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
  all: { zh: "全部语言", en: "All languages" },
};

const topicLexicon: Record<string, { zh: string; en: string; keywords: string[] }> = {
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
    keywords: ["performance", "fps", "stutter", "lag", "optimization", "optimize", "crash", "bug", "性能", "优化", "掉帧", "卡顿", "闪退", "崩溃"],
  },
  price: {
    zh: "价格与性价比",
    en: "Price and value",
    keywords: ["price", "value", "worth", "discount", "dlc", "pricing", "价格", "性价比", "值不值", "折扣", "售价"],
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
};

const positiveMarkers = [
  "good", "great", "excellent", "amazing", "fun", "love", "enjoy", "worth", "beautiful", "polished",
  "推荐", "好玩", "优秀", "喜欢", "值得", "良心", "惊艳", "上头", "耐玩", "舒服", "不错", "很棒",
];

const negativeMarkers = [
  "bad", "boring", "terrible", "awful", "worse", "poor", "buggy", "broken", "crash", "stutter", "refund",
  "不推荐", "无聊", "糟糕", "垃圾", "崩溃", "闪退", "卡顿", "掉帧", "重复", "贵", "不值", "失望", "烂",
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function safePercent(pos: number, total: number): number {
  return total > 0 ? (pos / total) * 100 : 0;
}

function getLangName(code: string, outputLanguage: "zh-CN" | "en"): string {
  const info = languageDisplayMap[code];
  if (!info) return code;
  return outputLanguage === "zh-CN" ? info.zh : info.en;
}

function mapPercentToSteamDesc(percentPositive: number, outputLanguage: "zh-CN" | "en"): string {
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

function normalizeReviewText(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function countMatches(text: string, tokens: string[]): number {
  const lower = text.toLowerCase();
  return tokens.reduce((acc, token) => acc + (lower.includes(token.toLowerCase()) ? 1 : 0), 0);
}

function detectSentiment(text: string): "positive" | "negative" | "neutral" {
  const pos = countMatches(text, positiveMarkers);
  const neg = countMatches(text, negativeMarkers);
  if (pos > neg) return "positive";
  if (neg > pos) return "negative";
  return "neutral";
}

function detectTopics(text: string): string[] {
  const lower = text.toLowerCase();
  const matched: string[] = [];
  for (const [topic, info] of Object.entries(topicLexicon)) {
    if (info.keywords.some((kw) => lower.includes(kw.toLowerCase()))) {
      matched.push(topic);
    }
  }
  return matched.length > 0 ? matched : ["gameplay"];
}

function buildTopicSummary(
  reviews: SteamReview[],
  outputLanguage: "zh-CN" | "en",
  sentiment: "positive" | "negative",
  maxBullets = 5,
): string[] {
  const topicCounts: Record<string, { count: number; examples: string[] }> = {};

  for (const review of reviews) {
    const clean = normalizeReviewText(review.review || "");
    if (!clean) continue;
    if (detectSentiment(clean) !== sentiment) continue;

    for (const topic of detectTopics(clean)) {
      const bucket = topicCounts[topic] ?? { count: 0, examples: [] };
      bucket.count += 1;
      if (bucket.examples.length < 2) {
        bucket.examples.push(clean.slice(0, 90).replace(/\s+/g, " ").trim());
      }
      topicCounts[topic] = bucket;
    }
  }

  return Object.entries(topicCounts)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, maxBullets)
    .map(([topic, data]) => {
      const info = Object.prototype.hasOwnProperty.call(topicLexicon, topic)
  ? topicLexicon[topic as keyof typeof topicLexicon]
  : undefined;

      const label = info
        ? (outputLanguage === "zh-CN" ? info.zh : info.en)
        : (outputLanguage === "zh-CN" ? "玩法与核心循环" : "Gameplay and core loop");
      
      const examples = data.examples.join(" / ");
      return outputLanguage === "zh-CN"
        ? `围绕「${label}」的${sentiment === "positive" ? "正面" : "负面"}提及较多（${data.count} 条高相关评论），常见反馈包括：${examples}`
        : `A large share of ${sentiment} comments focus on "${label}" (${data.count} highly relevant reviews). Common feedback includes: ${examples}`;
    });
}

function computeRecommendationScore(
  reviews: SteamReview[],
  overallSummary: SteamQuerySummary | undefined,
  summaryMode: "heuristic" | "two-stage",
): number {
  const total = reviews.length;
  if (!total) return 0;

  const contentPositive = reviews.filter((r) => detectSentiment(normalizeReviewText(r.review || "")) === "positive").length;
  const contentNegative = reviews.filter((r) => detectSentiment(normalizeReviewText(r.review || "")) === "negative").length;
  const contentScore = safePercent(contentPositive, Math.max(1, contentPositive + contentNegative));

  const steamOverallTotal = overallSummary?.total_reviews ?? 0;
  const steamOverallPositive = overallSummary?.total_positive ?? 0;
  const steamScore = steamOverallTotal > 0 ? safePercent(steamOverallPositive, steamOverallTotal) : 50;

  const reviewVolumeBonus = clamp(Math.log10(total + 1) * 8, 0, 18);
  const mixedPenalty = contentNegative > contentPositive ? 12 : 0;

  const score = summaryMode === "heuristic"
    ? contentScore * 0.7 + steamScore * 0.2 + reviewVolumeBonus - mixedPenalty
    : contentScore * 0.6 + steamScore * 0.3 + reviewVolumeBonus - mixedPenalty;

  return Math.round(clamp(score, 0, 100));
}

function buildRecommendationSummary(
  score: number,
  outputLanguage: "zh-CN" | "en",
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

function classifyFetchError(error: unknown): { retryable: boolean; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const cause = typeof error === "object" && error !== null && "cause" in error ? (error as { cause?: unknown }).cause : undefined;
  const causeCode =
    typeof cause === "object" && cause !== null && "code" in cause
      ? String((cause as { code?: unknown }).code ?? "")
      : "";

  const joined = `${message} ${causeCode}`.toUpperCase();

  const retryable =
    joined.includes("UND_ERR_SOCKET") ||
    joined.includes("ECONNRESET") ||
    joined.includes("ETIMEDOUT") ||
    joined.includes("ECONNREFUSED") ||
    joined.includes("EPIPE") ||
    joined.includes("OTHER SIDE CLOSED") ||
    joined.includes("FETCH FAILED") ||
    joined.includes("ABORT");

  return { retryable, message };
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= REQUEST_RETRY_COUNT; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          "User-Agent": "steam-review-summary-mcp/1.2",
          "Accept": "application/json, text/html;q=0.9, */*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
          "Cache-Control": "no-cache",
          "Pragma": "no-cache",
          ...(init?.headers ?? {}),
        },
      });

      clearTimeout(timeout);

      if (response.status === 429 || response.status >= 500) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        return (await response.json()) as T;
      }

      return JSON.parse(await response.text()) as T;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      const { retryable } = classifyFetchError(error);
      if (attempt >= REQUEST_RETRY_COUNT || !retryable) {
        break;
      }

      const delay = REQUEST_RETRY_BASE_DELAY_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
      await sleep(delay);
    }
  }

  const info = classifyFetchError(lastError);
  throw new Error(`Steam request failed after ${REQUEST_RETRY_COUNT + 1} attempts: ${info.message}`);
}

async function fetchText(url: string): Promise<string> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= REQUEST_RETRY_COUNT; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "steam-review-summary-mcp/1.2",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
          "Cache-Control": "no-cache",
          "Pragma": "no-cache",
        },
      });

      clearTimeout(timeout);

      if (response.status === 429 || response.status >= 500) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }

      return await response.text();
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      const { retryable } = classifyFetchError(error);
      if (attempt >= REQUEST_RETRY_COUNT || !retryable) {
        break;
      }

      const delay = REQUEST_RETRY_BASE_DELAY_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
      await sleep(delay);
    }
  }

  const info = classifyFetchError(lastError);
  throw new Error(`Steam request failed after ${REQUEST_RETRY_COUNT + 1} attempts: ${info.message}`);
}

async function fetchSteamSummary(
  appid: number,
  language: SteamLanguageCode,
  filter: "all" | "recent" = "all",
  dayRange = DEFAULT_RECENT_DAY_RANGE,
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
  if (filter === "all") {
    url.searchParams.set("day_range", String(dayRange));
  }

  const data = await fetchJson<AppReviewsResponse>(url.toString());
  return data.query_summary;
}

async function fetchSteamReviewsForLanguage(
  appid: number,
  language: SteamLanguageCode,
  maxReviews: number,
): Promise<{ language: string; summary?: SteamQuerySummary; reviews: SteamReview[] }> {
  let cursor = "*";
  let page = 0;
  let summary: SteamQuerySummary | undefined;
  const reviews: SteamReview[] = [];
  const seen = new Set<string>();

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

    const data = await fetchJson<AppReviewsResponse>(url.toString());

    if (data.success !== 1) {
      throw new Error(`Steam returned success=0 for language=${language}`);
    }

    if (!summary && data.query_summary) {
      summary = data.query_summary;
    }

    const pageReviews = data.reviews ?? [];
    if (pageReviews.length === 0) break;

    for (const review of pageReviews) {
      if (!review.recommendationid || seen.has(review.recommendationid)) continue;
      seen.add(review.recommendationid);
      reviews.push({
        ...review,
        language,
        review: normalizeReviewText(review.review || ""),
      });
      if (reviews.length >= maxReviews) break;
    }

    const nextCursor = data.cursor?.trim();
    if (!nextCursor || nextCursor === cursor) break;

    cursor = nextCursor;
    page += 1;
    if (page >= 50) break;

    await sleep(250);
  }

  return { language, summary, reviews };
}

function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => 0));

  for (let i = 0; i < rows; i += 1) dp[i]![0] = i;
  for (let j = 0; j < cols; j += 1) dp[0]![j] = j;

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const up = dp[i - 1]![j]!;
      const left = dp[i]![j - 1]!;
      const diag = dp[i - 1]![j - 1]!;
      dp[i]![j] = Math.min(up + 1, left + 1, diag + cost);
    }
  }

  return dp[a.length]![b.length]!;
}

function normalizeGameName(name: string): string {
  return normalizeReviewText(name)
    .toLowerCase()
    .replace(/[™®©]/g, "")
    .replace(/[^\p{L}\p{N}\s:'.-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreCandidate(query: string, candidate: string): number {
  const q = normalizeGameName(query);
  const c = normalizeGameName(candidate);

  if (!q || !c) return 0;
  if (q === c) return 100;

  let score = 0;
  if (c.includes(q)) score += 40;
  if (q.includes(c)) score += 10;

  const queryTokens = q.split(" ").filter(Boolean);
  const candidateTokens = c.split(" ").filter(Boolean);
  const overlap = queryTokens.filter((token) => candidateTokens.includes(token)).length;
  score += overlap * 10;

  const distance = levenshteinDistance(q, c);
  const maxLen = Math.max(q.length, c.length);
  const similarity = maxLen > 0 ? 1 - distance / maxLen : 0;
  score += similarity * 40;

  return score;
}

async function appidFromName(query: string, limit = DEFAULT_SEARCH_LIMIT): Promise<SearchItem[]> {
  const url = new URL("https://store.steampowered.com/search/suggest");
  url.searchParams.set("term", query);
  url.searchParams.set("f", "games");
  url.searchParams.set("cc", "US");
  url.searchParams.set("realm", "1");
  url.searchParams.set("l", "english");

  const html = await fetchText(url.toString());

  const results: SearchItem[] = [];
  const regex = /data-ds-appid="(\d+)".*?<div class="match_name">([\s\S]*?)<\/div>/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(html)) !== null) {
    const appidRaw = match[1];
    const nameRaw = match[2];
    if (!appidRaw || !nameRaw) continue;

    const appid = Number(appidRaw);
    if (!Number.isFinite(appid)) continue;

    const name = normalizeReviewText(nameRaw.replace(/<[^>]+>/g, ""));
    if (!name) continue;

    const score = scoreCandidate(query, name);
    results.push({
      id: `steam-app:${appid}`,
      appid,
      name,
      score,
    });
  }

  return results
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function formatStructuredText(result: SteamSummaryResult): string {
  const isZh = result.outputLanguage === "zh-CN";
  const overall = result.steamLevels.overall;
  const recent = result.steamLevels.recentOverall;

  const selectedLanguageLines = result.steamLevels.selectedLanguages.map((item) => {
    const label = getLangName(item.language, result.outputLanguage);
    const desc = item.summary.review_score_desc ?? (isZh ? "无" : "N/A");
    const total = item.summary.total_reviews ?? 0;
    const pos = item.summary.total_positive ?? 0;
    const neg = item.summary.total_negative ?? 0;
    return isZh
      ? `- ${label}: ${desc}（总计 ${total}，好评 ${pos}，差评 ${neg}）`
      : `- ${label}: ${desc} (total ${total}, positive ${pos}, negative ${neg})`;
  });

  const usedLangText = result.languagesUsed.map((x) => getLangName(x, result.outputLanguage)).join(isZh ? "、" : ", ");

  const combinedLine = result.steamLevels.combinedSelectedDerived
    ? isZh
      ? `- 所选语言合并后的推导结果: ${result.steamLevels.combinedSelectedDerived.reviewScoreDesc}（总计 ${result.steamLevels.combinedSelectedDerived.total}，好评率 ${result.steamLevels.combinedSelectedDerived.percentPositive.toFixed(1)}%）`
      : `- Derived combined result across selected languages: ${result.steamLevels.combinedSelectedDerived.reviewScoreDesc} (total ${result.steamLevels.combinedSelectedDerived.total}, positive rate ${result.steamLevels.combinedSelectedDerived.percentPositive.toFixed(1)}%)`
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
    ...result.positiveBullets.map((x) => `- ${x}`),
    "",
    `## ${isZh ? "负面反馈摘要" : "Negative review summary"}`,
    ...result.negativeBullets.map((x) => `- ${x}`),
    "",
    `## ${isZh ? "购买推荐分" : "Buy recommendation score"}`,
    `- ${result.recommendationScore}/100`,
    "",
    `## ${isZh ? "结论" : "Conclusion"}`,
    result.recommendationSummary,
  ].join("\n");
}

async function summarizeSteamReviews(args: {
  appid: number;
  languages: string[];
  outputLanguage: "zh-CN" | "en";
  summaryMode: "heuristic" | "two-stage";
  minReviewCountForEnglishFallback: number;
  maxReviewsPerLanguage: number;
  recentDayRange: number;
}): Promise<SteamSummaryResult> {
  const {
    appid,
    languages,
    outputLanguage,
    summaryMode,
    minReviewCountForEnglishFallback,
    maxReviewsPerLanguage,
    recentDayRange,
  } = args;

  const requestedLanguages = uniqueStrings((languages.length ? languages : DEFAULT_LANGUAGES).map((x) => x.trim().toLowerCase()));

  const overallPromise = fetchSteamSummary(appid, "all", "all", recentDayRange);
  const recentPromise = fetchSteamSummary(appid, "all", "recent", recentDayRange);

  const perLanguageResponses = await Promise.all(
    requestedLanguages.map((language) => fetchSteamReviewsForLanguage(appid, language, maxReviewsPerLanguage)),
  );

  let usedLanguages = [...requestedLanguages];
  let selectedReviews = perLanguageResponses.flatMap((x) => x.reviews);

  if (selectedReviews.length < minReviewCountForEnglishFallback && !usedLanguages.includes("english")) {
    const english = await fetchSteamReviewsForLanguage(appid, "english", maxReviewsPerLanguage);
    perLanguageResponses.push(english);
    usedLanguages.push("english");
    selectedReviews = perLanguageResponses.flatMap((x) => x.reviews);
  }

  const dedupedMap = new Map<string, SteamReview>();
  for (const review of selectedReviews) {
    if (!review.recommendationid) continue;
    if (!dedupedMap.has(review.recommendationid)) {
      dedupedMap.set(review.recommendationid, review);
    }
  }
  const dedupedReviews = [...dedupedMap.values()];

  const recommendationLabelPositive = dedupedReviews.filter((r) => r.voted_up).length;
  const recommendationLabelNegative = dedupedReviews.length - recommendationLabelPositive;
  const contentPositive = dedupedReviews.filter((r) => detectSentiment(r.review || "") === "positive").length;
  const contentNegative = dedupedReviews.filter((r) => detectSentiment(r.review || "") === "negative").length;
  const contentNeutral = dedupedReviews.length - contentPositive - contentNegative;

  const selectedLangSummaries = perLanguageResponses.map((item) => ({
    language: item.language,
    summary: item.summary ?? {},
  }));

  const derivedPositive = selectedLangSummaries.reduce((sum, x) => sum + (x.summary.total_positive ?? 0), 0);
  const derivedNegative = selectedLangSummaries.reduce((sum, x) => sum + (x.summary.total_negative ?? 0), 0);
  const derivedTotal = derivedPositive + derivedNegative;
  const derivedPercent = safePercent(derivedPositive, Math.max(1, derivedTotal));

  const overall = (await overallPromise) ?? {};
  const recentOverall = (await recentPromise) ?? {};

  const positiveBullets = buildTopicSummary(dedupedReviews, outputLanguage, "positive", 5);
  const negativeBullets = buildTopicSummary(dedupedReviews, outputLanguage, "negative", 5);
  const recommendationScore = computeRecommendationScore(dedupedReviews, overall, summaryMode);
  const recommendationSummary = buildRecommendationSummary(recommendationScore, outputLanguage, positiveBullets, negativeBullets);

  return {
    appid,
    languagesRequested: requestedLanguages,
    languagesUsed: usedLanguages,
    outputLanguage,
    summaryMode,
    totals: {
      totalReviewsConsidered: dedupedReviews.length,
      recommendationLabelPositive,
      recommendationLabelNegative,
      contentPositive,
      contentNegative,
      contentNeutral,
    },
    steamLevels: {
      overall,
      recentOverall,
      selectedLanguages: selectedLangSummaries,
      combinedSelectedDerived: selectedLangSummaries.length > 1
        ? {
            positive: derivedPositive,
            negative: derivedNegative,
            total: derivedTotal,
            percentPositive: derivedPercent,
            reviewScoreDesc: mapPercentToSteamDesc(derivedPercent, outputLanguage),
          }
        : undefined,
    },
    positiveBullets: positiveBullets.length
      ? positiveBullets
      : [outputLanguage === "zh-CN" ? "未提取到足够集中的正面主题。" : "No concentrated positive theme could be extracted."],
    negativeBullets: negativeBullets.length
      ? negativeBullets
      : [outputLanguage === "zh-CN" ? "未提取到足够集中的负面主题。" : "No concentrated negative theme could be extracted."],
    recommendationScore,
    recommendationSummary,
  };
}

export function createSteamReviewServer(): McpServer {
  const server = new McpServer({
    name: "steam-review-summary-mcp",
    version: "1.2.0",
  });

  server.tool(
    "appid_from_name",
    "Find Steam AppIDs from a game name.",
    {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(10).default(DEFAULT_SEARCH_LIMIT),
    },
    async ({ query, limit }) => {
      const items = await appidFromName(query, limit);
      return {
        content: [
          {
            type: "text",
            text: items.length
              ? items.map((item, idx) => `${idx + 1}. ${item.name} (appid=${item.appid}, id=${item.id}, score=${item.score.toFixed(1)})`).join("\n")
              : "No matching Steam apps found.",
          },
        ],
        structuredContent: {
          query,
          items,
        },
      };
    },
  );

  server.tool(
    "search",
    "Search Steam games by name and return stable ids such as steam-app:<appid>.",
    {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(10).default(DEFAULT_SEARCH_LIMIT),
    },
    async ({ query, limit }) => {
      const items = await appidFromName(query, limit);
      return {
        content: [
          {
            type: "text",
            text: items.length
              ? items.map((item, idx) => `${idx + 1}. ${item.name} -> ${item.id}`).join("\n")
              : "No matching Steam apps found.",
          },
        ],
        structuredContent: { query, items },
      };
    },
  );

  server.tool(
    "query",
    "Alias of search.",
    {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(10).default(DEFAULT_SEARCH_LIMIT),
    },
    async ({ query, limit }) => {
      const items = await appidFromName(query, limit);
      return {
        content: [
          {
            type: "text",
            text: items.length
              ? items.map((item, idx) => `${idx + 1}. ${item.name} -> ${item.id}`).join("\n")
              : "No matching Steam apps found.",
          },
        ],
        structuredContent: { query, items },
      };
    },
  );

  const summarySchema = {
    appid: z.number().int().positive(),
    languages: z.array(z.string()).default(DEFAULT_LANGUAGES),
    outputLanguage: z.enum(["zh-CN", "en"]).default(DEFAULT_OUTPUT_LANGUAGE),
    summaryMode: z.enum(["heuristic", "two-stage"]).default(DEFAULT_SUMMARY_MODE),
    minReviewCountForEnglishFallback: z.number().int().min(1).max(500).default(DEFAULT_MIN_REVIEW_COUNT_FOR_ENGLISH_FALLBACK),
    maxReviewsPerLanguage: z.number().int().min(20).max(1000).default(DEFAULT_MAX_REVIEWS_PER_LANGUAGE),
    recentDayRange: z.number().int().min(1).max(365).default(DEFAULT_RECENT_DAY_RANGE),
  } as const;

  server.tool(
    "summarize_steam_reviews",
    "Load Steam reviews for a game in selected languages and return a structured summary.",
    summarySchema,
    async (args) => {
      const result = await summarizeSteamReviews(args);
      return {
        content: [{ type: "text", text: formatStructuredText(result) }],
        structuredContent: result,
      };
    },
  );

  server.tool(
    "fetch",
    "Fetch a Steam review summary from a stable id such as steam-app:<appid>.",
    {
      id: z.string().regex(/^steam-app:\d+$/),
      languages: z.array(z.string()).default(DEFAULT_LANGUAGES),
      outputLanguage: z.enum(["zh-CN", "en"]).default(DEFAULT_OUTPUT_LANGUAGE),
      summaryMode: z.enum(["heuristic", "two-stage"]).default(DEFAULT_SUMMARY_MODE),
      minReviewCountForEnglishFallback: z.number().int().min(1).max(500).default(DEFAULT_MIN_REVIEW_COUNT_FOR_ENGLISH_FALLBACK),
      maxReviewsPerLanguage: z.number().int().min(20).max(1000).default(DEFAULT_MAX_REVIEWS_PER_LANGUAGE),
      recentDayRange: z.number().int().min(1).max(365).default(DEFAULT_RECENT_DAY_RANGE),
    },
    async ({ id, languages, outputLanguage, summaryMode, minReviewCountForEnglishFallback, maxReviewsPerLanguage, recentDayRange }) => {
      const appid = Number(id.replace("steam-app:", ""));
      const result = await summarizeSteamReviews({
        appid,
        languages,
        outputLanguage,
        summaryMode,
        minReviewCountForEnglishFallback,
        maxReviewsPerLanguage,
        recentDayRange,
      });

      return {
        content: [{ type: "text", text: formatStructuredText(result) }],
        structuredContent: result,
      };
    },
  );

  return server;
}
