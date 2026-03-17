import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BinanceAnnouncementsPoller,
  articleToSignal,
  pollBinanceAnnouncements,
} from "../src/skills/alphaos/living-assistant/signal-radar";
import type {
  BinanceArticle,
  BinanceCatalog,
} from "../src/skills/alphaos/living-assistant/signal-radar/pollers/binance-announcements";

const originalFetch = globalThis.fetch;

function buildArticle(id: number, title: string, releaseDate = 1773716401712): BinanceArticle {
  return {
    id,
    code: `code-${id}`,
    title,
    type: 1,
    releaseDate,
  };
}

function buildCatalog(catalogId: number, name: string, articles: BinanceArticle[]): BinanceCatalog {
  return {
    catalogId,
    catalogName: name,
    total: articles.length,
    articles,
  };
}

function buildApiResponse(catalogs: BinanceCatalog[]): unknown {
  return {
    code: "000000",
    success: true,
    data: {
      catalogs,
    },
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("living assistant binance announcements poller", () => {
  it("maps a Binance article into a normalized signal", () => {
    const fetchedAt = "2026-03-17T08:00:00.000Z";
    const article = buildArticle(268514, "Binance Margin Will Add New Pairs", 1773716401712);
    const catalog = buildCatalog(48, "New Cryptocurrency Listing", [article]);

    const signal = articleToSignal(article, catalog, fetchedAt);

    expect(signal.signalId).toBe("binance-ann-268514");
    expect(signal.source).toBe("binance_announcement");
    expect(signal.type).toBe("new_listing");
    expect(signal.urgency).toBe("high");
    expect(signal.relevanceHint).toBe("likely_relevant");
    expect(signal.title).toBe(article.title);
    expect(signal.detectedAt).toBe(new Date(article.releaseDate).toISOString());
    expect(signal.rawPayload).toEqual({ article, catalog });
  });

  it("deduplicates articles across consecutive poll calls", async () => {
    const payload = buildApiResponse([
      buildCatalog(48, "New Cryptocurrency Listing", [
        buildArticle(1001, "Listing update 1"),
        buildArticle(1002, "Listing update 2"),
      ]),
    ]);

    const mockFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const poller = new BinanceAnnouncementsPoller({
      endpoint: "https://example.com/binance",
      pageSize: 20,
    });

    const first = await poller.poll();
    const second = await poller.poll();

    expect(first.error).toBeUndefined();
    expect(first.articleCount).toBe(2);
    expect(first.signals).toHaveLength(2);

    expect(second.error).toBeUndefined();
    expect(second.articleCount).toBe(2);
    expect(second.signals).toHaveLength(0);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [requestUrl] = mockFetch.mock.calls[0] ?? [];
    expect(String(requestUrl)).toContain("type=1");
    expect(String(requestUrl)).toContain("pageNo=1");
    expect(String(requestUrl)).toContain("pageSize=20");
  });

  it("filters catalogs based on includeCatalogIds", async () => {
    const payload = buildApiResponse([
      buildCatalog(48, "New Cryptocurrency Listing", [buildArticle(2001, "Listing A")]),
      buildCatalog(161, "Delisting", [buildArticle(2002, "Delisting B")]),
    ]);

    const mockFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const poller = new BinanceAnnouncementsPoller({
      includeCatalogIds: [161],
    });

    const result = await poller.poll();

    expect(result.error).toBeUndefined();
    expect(result.articleCount).toBe(1);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]?.type).toBe("delisting");
    expect(result.signals[0]?.signalId).toBe("binance-ann-2002");
  });

  it("returns an error result when network fetch fails", async () => {
    const failingFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => {
        throw new Error("network down");
      },
    );
    globalThis.fetch = failingFetch as unknown as typeof fetch;

    const poller = new BinanceAnnouncementsPoller();
    const result = await poller.poll();

    expect(result.signals).toEqual([]);
    expect(result.articleCount).toBe(0);
    expect(result.error).toContain("network down");
  });

  it("supports start and stop interval polling", async () => {
    vi.useFakeTimers();

    const payloads = [
      buildApiResponse([
        buildCatalog(48, "New Cryptocurrency Listing", [buildArticle(3001, "Listing 1")]),
      ]),
      buildApiResponse([
        buildCatalog(48, "New Cryptocurrency Listing", [
          buildArticle(3001, "Listing 1"),
          buildArticle(3002, "Listing 2"),
        ]),
      ]),
    ];

    let callIndex = 0;
    const mockFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => {
        const payload = payloads[Math.min(callIndex, payloads.length - 1)] as unknown;
        callIndex += 1;
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const poller = new BinanceAnnouncementsPoller({ pollIntervalMs: 1000 });
    const callbackSignals: string[][] = [];

    poller.start((signals) => {
      callbackSignals.push(signals.map((item) => item.signalId));
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(callbackSignals).toEqual([["binance-ann-3001"]]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(callbackSignals).toEqual([["binance-ann-3001"], ["binance-ann-3002"]]);

    poller.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(callbackSignals).toHaveLength(2);
  });

  it("exposes pollBinanceAnnouncements helper", async () => {
    const payload = buildApiResponse([
      buildCatalog(128, "Crypto Airdrop", [buildArticle(4001, "Airdrop Campaign")]),
    ]);
    const mockFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const result = await pollBinanceAnnouncements();

    expect(result.error).toBeUndefined();
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]?.type).toBe("airdrop");
  });
});
