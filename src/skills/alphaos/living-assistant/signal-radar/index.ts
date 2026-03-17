import {
  BinanceAnnouncementsPoller,
  type BinanceAnnouncementsPollerConfig,
  type BinanceAnnouncementsPollerResult,
} from "./pollers/binance-announcements";

export * from "./types";
export * from "./normalizer";
export * from "./capsule-loader";
export * from "./pollers/binance-announcements";

export async function pollBinanceAnnouncements(
  config?: BinanceAnnouncementsPollerConfig,
): Promise<BinanceAnnouncementsPollerResult> {
  const poller = new BinanceAnnouncementsPoller(config);
  return poller.poll();
}
