import { idempotencyKeys, schedules } from "@trigger.dev/sdk";
import { summarizeVideo } from "./summarize-video.js";

// Cron runs once every 2 days; look back 49 hours so nothing is missed at the boundary between runs.
const LOOKBACK_MS = 49 * 60 * 60 * 1000;

type FeedVideo = {
  id: string;
  title: string;
  publishedAt: Date;
  isShort: boolean;
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseFeed(xml: string): FeedVideo[] {
  const videos: FeedVideo[] = [];
  for (const entry of xml.split("<entry>").slice(1)) {
    const id = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
    const title = entry.match(/<title>([^<]*)<\/title>/)?.[1];
    const link = entry.match(/<link rel="alternate" href="([^"]+)"/)?.[1];
    const published = entry.match(/<published>([^<]+)<\/published>/)?.[1];
    if (!id || !title || !published) continue;
    videos.push({
      id,
      title: decodeEntities(title),
      publishedAt: new Date(published),
      isShort: link?.includes("/shorts/") ?? false,
    });
  }
  return videos;
}

export const checkNewVideos = schedules.task({
  id: "malkansview-check-new-videos",
  // Every 2 days at 9:00 AM India time. Trigger.dev only accepts the older "Asia/Calcutta" name for IST.
  cron: { pattern: "0 9 */2 * *", timezone: "Asia/Calcutta" },
  run: async () => {
    const rawChannelId = process.env.YOUTUBE_CHANNEL_ID;
    if (!rawChannelId) throw new Error("YOUTUBE_CHANNEL_ID is not set");
    // Defensive: strip stray whitespace/quotes a dashboard paste can leave in (not a secret, safe to log).
    const channelId = rawChannelId.trim().replace(/^['"]|['"]$/g, "");
    console.log(`Using YouTube channel ID: "${channelId}"`);

    const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
    const res = await fetch(feedUrl);
    if (!res.ok) throw new Error(`YouTube feed request failed: ${res.status} (url: ${feedUrl})`);

    const cutoff = Date.now() - LOOKBACK_MS;
    const fresh = parseFeed(await res.text()).filter(
      (video) => !video.isShort && video.publishedAt.getTime() >= cutoff
    );

    if (fresh.length === 0) {
      console.log("No new videos");
      return { dispatched: 0 };
    }

    for (const video of fresh) {
      await summarizeVideo.trigger(
        {
          videoId: video.id,
          title: video.title,
          url: `https://www.youtube.com/watch?v=${video.id}`,
        },
        {
          // Global scope: a video seen in two consecutive windows is only summarised once.
          idempotencyKey: await idempotencyKeys.create(`malkansview-video-${video.id}`, {
            scope: "global",
          }),
        }
      );
    }

    console.log(`Dispatched ${fresh.length} video(s)`);
    return { dispatched: fresh.length };
  },
});
