import Link from "next/link";
import { fetchFeed, mediaUrl, Reel } from "@/lib/api";
import ReelThumbnail from "@/components/ReelThumbnail";
import FeaturedVideo from "@/components/FeaturedVideo";
import DeleteReelButton from "@/components/DeleteReelButton";

export const dynamic = "force-dynamic";

const PINNED_REEL_ID = "7a9093c3-ca3f-42c4-8278-0fd4f0ccfdd7";

const TECH_PILLS = [
  "Groq GPT-OSS 120B",
  "Pollinations.ai",
  "Edge TTS",
  "FFmpeg",
  "Next.js 14",
  "TypeScript",
];

function sceneImg(reel: Reel) {
  const s = reel.scenes?.[0] as any;
  const isNew = !!s?.imageUrlStart;
  const local = mediaUrl(`/media/${reel.id}/scene-1${isNew ? "-start" : ""}.jpg`);
  const external = s?.imageUrlStart || s?.imageUrl;
  return { local, external };
}

export default async function HomePage() {
  let reels: Reel[] = [];
  try {
    reels = await fetchFeed();
  } catch {
    /* backend offline */
  }

  if (!reels.length) {
    return (
      <div className="empty-state">
        <div className="empty-icon">🎬</div>
        <h1 className="empty-title">No reels yet</h1>
        <p className="empty-desc">
          Generate your first AI short drama — one prompt becomes a full script,
          comic-style art, neural narration, and a loopable vertical video.
        </p>
        <div className="tech-pills">
          {TECH_PILLS.map((t) => (
            <span key={t} className="tech-pill">{t}</span>
          ))}
        </div>
        <Link href="/generate" className="btn-primary btn-lg">
          Generate your first reel →
        </Link>
        <p className="empty-hint">Backend must be running on localhost:4000</p>
      </div>
    );
  }

  const pinned = reels.find((r) => r.id === PINNED_REEL_ID) ?? reels[0];
  const rest = reels.filter((r) => r.id !== pinned.id);
  const { local: pinnedPoster } = sceneImg(pinned);

  // Play the pinned reel's actual rendered video directly (R2 URL in
  // production, local /media path in dev) instead of a separately
  // pre-assembled file that may not exist on this deployment.
  const featuredSrc = mediaUrl(pinned.videoUrl);

  return (
    <div className="home-page">
      <FeaturedVideo
        src={featuredSrc}
        poster={pinnedPoster}
        reelId={pinned.id}
        title={pinned.title}
        hook={pinned.hook}
        hashtags={pinned.hashtags ?? []}
        techPills={TECH_PILLS}
      />

      {rest.length > 0 && (
        <section className="more-reels-section">
          <p className="section-eyebrow">More Reels</p>
          <div className="reels-grid">
            {rest.map((reel) => {
              const { local: localSrc, external: fallbackSrc } = sceneImg(reel);
              return (
                <div key={reel.id} className="mini-reel-card">
                  <div className="mini-reel-thumb">
                    <Link href={`/reels/${reel.id}`} className="mini-reel-thumb-link">
                      <ReelThumbnail
                        src={localSrc}
                        fallback={fallbackSrc}
                        alt={reel.title}
                      />
                    </Link>
                    <a
                      href={mediaUrl(reel.videoUrl)}
                      download={`${reel.title.replace(/[^a-z0-9]/gi, "-")}.mp4`}
                      className="mini-reel-download"
                      title="Download MP4"
                    >
                      ↓
                    </a>
                    <DeleteReelButton reelId={reel.id} />
                  </div>
                  <Link href={`/reels/${reel.id}`} className="mini-reel-info">
                    <p className="mini-reel-name">{reel.title}</p>
                    <p className="mini-reel-scenes">
                      {reel.scenes?.length ?? 0} scenes
                    </p>
                  </Link>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
