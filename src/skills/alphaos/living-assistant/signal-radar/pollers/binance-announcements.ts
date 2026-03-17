import type { NormalizedSignal, SignalRelevanceHint, SignalUrgency } from "../types";

const DEFAULT_ENDPOINT = "https://www.binance.com/bapi/composite/v1/public/cms/article/list/query";
const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_INCLUDE_CATALOG_IDS = [48, 49, 161, 128] as const;

export interface BinanceAnnouncementsPollerConfig {
  endpoint?: string;
  pageSize?: number;
  pollIntervalMs?: number;
  includeCatalogIds?: number[];
}

export interface BinanceAnnouncementsPollerResult {
  signals: NormalizedSignal[];
  fetchedAt: string;
  articleCount: number;
  error?: string;
}

export interface BinanceArticle {
  id: number;
  code: string;
  title: string;
  type: number;
  releaseDate: number;
}

export interface BinanceCatalog {
  catalogId: number;
  catalogName: string;
  total: number;
  articles: BinanceArticle[];
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function readNumber(input: unknown): number | null {
  if (typeof input === "number" && Number.isFinite(input)) {
    return input;
  }
  if (typeof input === "string" && input.trim()) {
    const parsed = Number(input);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function asPositiveInt(input: number | undefined, fallback: number): number {
  const value = typeof input === "number" && Number.isFinite(input) ? Math.floor(input) : fallback;
  return value > 0 ? value : fallback;
}

function normalizeCatalogIds(input: number[] | undefined): number[] {
  if (!input || input.length === 0) {
    return [...DEFAULT_INCLUDE_CATALOG_IDS];
  }

  const ids = input
    .map((value) => readNumber(value))
    .filter((value): value is number => typeof value === "number")
    .map((value) => Math.trunc(value));

  const deduped = [...new Set(ids)];
  return deduped.length > 0 ? deduped : [...DEFAULT_INCLUDE_CATALOG_IDS];
}

function mapCatalogToSignalType(catalogId: number): string {
  switch (catalogId) {
    case 48:
      return "new_listing";
    case 161:
      return "delisting";
    case 128:
      return "airdrop";
    case 49:
      return "exchange_news";
    default:
      return "announcement";
  }
}

function mapCatalogToUrgency(catalogId: number): SignalUrgency {
  switch (catalogId) {
    case 48:
    case 161:
      return "high";
    case 128:
    case 49:
      return "medium";
    default:
      return "low";
  }
}

function mapCatalogToRelevance(catalogId: number): SignalRelevanceHint {
  switch (catalogId) {
    case 48:
    case 161:
    case 128:
      return "likely_relevant";
    case 49:
      return "unknown";
    default:
      return "unknown";
  }
}

function normalizeReleaseTimestamp(releaseDate: number, fallbackIso: string): string {
  const parsed = new Date(releaseDate);
  if (Number.isNaN(parsed.getTime())) {
    return fallbackIso;
  }
  return parsed.toISOString();
}

function parseArticle(input: unknown): BinanceArticle | null {
  if (!isRecord(input)) {
    return null;
  }

  const id = readNumber(input.id);
  const releaseDate = readNumber(input.releaseDate);
  if (id === null || releaseDate === null) {
    return null;
  }

  const rawTitle = input.title;
  const title = typeof rawTitle === "string" ? rawTitle.trim() : "";
  if (!title) {
    return null;
  }

  const type = readNumber(input.type) ?? 1;
  const code = typeof input.code === "string" ? input.code : "";

  return {
    id: Math.trunc(id),
    code,
    title,
    type: Math.trunc(type),
    releaseDate: Math.trunc(releaseDate),
  };
}

function parseCatalog(input: unknown): BinanceCatalog | null {
  if (!isRecord(input)) {
    return null;
  }

  const catalogId = readNumber(input.catalogId);
  if (catalogId === null) {
    return null;
  }

  const catalogName = typeof input.catalogName === "string" ? input.catalogName : `catalog-${catalogId}`;
  const rawArticles = Array.isArray(input.articles) ? input.articles : [];
  const articles = rawArticles.map((article) => parseArticle(article)).filter((article): article is BinanceArticle => article !== null);
  const total = readNumber(input.total) ?? articles.length;

  return {
    catalogId: Math.trunc(catalogId),
    catalogName,
    total: Math.max(0, Math.trunc(total)),
    articles,
  };
}

function parseCatalogsFromResponse(input: unknown): BinanceCatalog[] | null {
  if (!isRecord(input)) {
    return null;
  }

  const data = input.data;
  if (!isRecord(data) || !Array.isArray(data.catalogs)) {
    return null;
  }

  return data.catalogs
    .map((catalog) => parseCatalog(catalog))
    .filter((catalog): catalog is BinanceCatalog => catalog !== null);
}

function messageFromError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}

export function articleToSignal(
  article: BinanceArticle,
  catalog: BinanceCatalog,
  fetchedAt: string,
): NormalizedSignal {
  return {
    signalId: `binance-ann-${article.id}`,
    source: "binance_announcement",
    type: mapCatalogToSignalType(catalog.catalogId),
    title: article.title,
    urgency: mapCatalogToUrgency(catalog.catalogId),
    relevanceHint: mapCatalogToRelevance(catalog.catalogId),
    detectedAt: normalizeReleaseTimestamp(article.releaseDate, fetchedAt),
    rawPayload: {
      article,
      catalog,
    },
  };
}

export class BinanceAnnouncementsPoller {
  private readonly endpoint: string;
  private readonly pageSize: number;
  private readonly pollIntervalMs: number;
  private readonly includeCatalogIds: Set<number>;
  private readonly lastFetchedArticleIds: Set<number> = new Set<number>();
  private timer: NodeJS.Timeout | null = null;
  private pollInFlight = false;

  constructor(config: BinanceAnnouncementsPollerConfig = {}) {
    this.endpoint = config.endpoint?.trim() || DEFAULT_ENDPOINT;
    this.pageSize = asPositiveInt(config.pageSize, DEFAULT_PAGE_SIZE);
    this.pollIntervalMs = asPositiveInt(config.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
    this.includeCatalogIds = new Set<number>(normalizeCatalogIds(config.includeCatalogIds));
  }

  async poll(): Promise<BinanceAnnouncementsPollerResult> {
    const fetchedAt = new Date().toISOString();
    const params = new URLSearchParams({
      type: "1",
      pageNo: "1",
      pageSize: String(this.pageSize),
    });
    const requestUrl = `${this.endpoint}?${params.toString()}`;

    let response: Response;
    try {
      response = await fetch(requestUrl, {
        method: "GET",
      });
    } catch (error) {
      return {
        signals: [],
        fetchedAt,
        articleCount: 0,
        error: `[binance-announcements] request failed: ${messageFromError(error)}`,
      };
    }

    if (!response.ok) {
      const details = await safeReadText(response);
      const suffix = details ? ` - ${details}` : "";
      return {
        signals: [],
        fetchedAt,
        articleCount: 0,
        error: `[binance-announcements] HTTP ${response.status} ${response.statusText}${suffix}`,
      };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      return {
        signals: [],
        fetchedAt,
        articleCount: 0,
        error: `[binance-announcements] failed to parse JSON response: ${messageFromError(error)}`,
      };
    }

    const catalogs = parseCatalogsFromResponse(payload);
    if (!catalogs) {
      return {
        signals: [],
        fetchedAt,
        articleCount: 0,
        error: "[binance-announcements] unexpected response shape",
      };
    }

    const filteredCatalogs = catalogs.filter((catalog) => this.includeCatalogIds.has(catalog.catalogId));
    let articleCount = 0;
    const signals: NormalizedSignal[] = [];

    for (const catalog of filteredCatalogs) {
      for (const article of catalog.articles) {
        articleCount += 1;
        if (this.lastFetchedArticleIds.has(article.id)) {
          continue;
        }

        this.lastFetchedArticleIds.add(article.id);
        signals.push(articleToSignal(article, catalog, fetchedAt));
      }
    }

    return {
      signals,
      fetchedAt,
      articleCount,
    };
  }

  start(onNewSignals: (signals: NormalizedSignal[]) => void): void {
    if (this.timer) {
      return;
    }

    const run = async (): Promise<void> => {
      if (this.pollInFlight) {
        return;
      }

      this.pollInFlight = true;
      try {
        const result = await this.poll();
        if (result.signals.length > 0) {
          try {
            onNewSignals(result.signals);
          } catch {
            // Callback failures should not stop interval polling.
          }
        }
      } finally {
        this.pollInFlight = false;
      }
    };

    void run();
    this.timer = setInterval(() => {
      void run();
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }
}
