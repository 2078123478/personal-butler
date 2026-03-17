# Live Signal Polling Implementation Task

## Goal

Implement a Binance Announcements poller that fetches announcements and converts them into `NormalizedSignal` objects for the Living Assistant loop.

## Context

- Existing code: `src/skills/alphaos/living-assistant/signal-radar/` already has types and normalizer
- `NormalizedSignal` type is defined in `signal-radar/types.ts`
- The loop expects `NormalizedSignal` as input

## API Details

**Endpoint**: `https://www.binance.com/bapi/composite/v1/public/cms/article/list/query`

**Query params**: `type=1&pageNo=1&pageSize=20`

**Response structure**:
```json
{
  "code": "000000",
  "success": true,
  "data": {
    "catalogs": [
      {
        "catalogId": 48,
        "catalogName": "New Cryptocurrency Listing",
        "total": 2109,
        "articles": [
          {
            "id": 268514,
            "code": "f826d6e2bfe34f309f203553c4778076",
            "title": "Binance Margin Will Add New Pairs - 2026-03-17",
            "type": 1,
            "releaseDate": 1773716401712
          }
        ]
      }
    ]
  }
}
```

**Important catalogs** (by catalogId):
- 48: New Cryptocurrency Listing (high priority for trading)
- 49: Latest Binance News
- 161: Delisting (risk signals)
- 128: Crypto Airdrop

## Implementation Requirements

### 1. Create poller module

**Location**: `src/skills/alphaos/living-assistant/signal-radar/pollers/binance-announcements.ts`

**Exports**:
```typescript
export interface BinanceAnnouncementsPollerConfig {
  endpoint?: string;  // default: "https://www.binance.com/bapi/composite/v1/public/cms/article/list/query"
  pageSize?: number;  // default: 20
  pollIntervalMs?: number;  // default: 60000 (1 minute)
  includeCatalogIds?: number[];  // default: [48, 49, 161, 128]
}

export interface BinanceAnnouncementsPollerResult {
  signals: NormalizedSignal[];
  fetchedAt: string;
  articleCount: number;
  error?: string;
}

export class BinanceAnnouncementsPoller {
  constructor(config?: BinanceAnnouncementsPollerConfig);
  
  // Fetch once and return signals
  async poll(): Promise<BinanceAnnouncementsPollerResult>;
  
  // Start polling on interval, calls onNewSignals callback
  start(onNewSignals: (signals: NormalizedSignal[]) => void): void;
  
  // Stop polling
  stop(): void;
}
```

### 2. Article to NormalizedSignal mapping

```typescript
function articleToSignal(
  article: BinanceArticle,
  catalog: BinanceCatalog,
  fetchedAt: string
): NormalizedSignal {
  return {
    signalId: `binance-ann-${article.id}`,
    source: 'binance_announcement',
    type: mapCatalogToSignalType(catalog.catalogId),
    title: article.title,
    urgency: mapCatalogToUrgency(catalog.catalogId),
    relevanceHint: mapCatalogToRelevance(catalog.catalogId),
    detectedAt: new Date(article.releaseDate).toISOString(),
    rawPayload: { article, catalog },
  };
}
```

**Urgency mapping**:
- catalogId 48 (New Listing) → `high`
- catalogId 161 (Delisting) → `high`
- catalogId 128 (Airdrop) → `medium`
- catalogId 49 (News) → `medium`
- others → `low`

**Type mapping**:
- 48 → `new_listing`
- 161 → `delisting`
- 128 → `airdrop`
- 49 → `exchange_news`
- others → `announcement`

### 3. Deduplication

The poller should track `lastFetchedArticleIds: Set<number>` and only emit new signals for articles not seen before.

### 4. Tests

Create `tests/living-assistant-binance-poller.test.ts`:
- Test article to signal mapping
- Test deduplication (poll twice, second time returns fewer)
- Test catalog filtering
- Test error handling (network failure returns error, not throw)

### 5. Integration with loop

Add a helper function in `signal-radar/index.ts`:
```typescript
export async function pollBinanceAnnouncements(
  config?: BinanceAnnouncementsPollerConfig
): Promise<BinanceAnnouncementsPollerResult>;
```

## Constraints

- Use native `fetch`, no external HTTP libraries
- No mutable global state (config and state passed via class instance)
- Poller should be stoppable
- Handle network errors gracefully (return error in result, don't throw)
- All timestamps in ISO 8601 format

## Acceptance Criteria

- [ ] `BinanceAnnouncementsPoller` class compiles
- [ ] `poll()` returns `NormalizedSignal[]` from live API
- [ ] Deduplication works across multiple `poll()` calls
- [ ] `start()` / `stop()` manage interval correctly
- [ ] Catalog filtering works
- [ ] Unit tests pass
- [ ] `npm run build && npm test` passes
