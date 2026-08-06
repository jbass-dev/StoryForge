import "dotenv/config";
// Polyfill the global Web Crypto API (globalThis.crypto) - Node only exposes
// this without a flag starting in v19. We're pinned to Node 18.20.8 on
// Railway, and msedge-tts calls crypto.subtle.digest()/crypto.getRandomValues()
// directly as a bare global (no import), so without this it throws
// "crypto is not defined" and narration synthesis silently fails, producing
// reels with no audio track. Must run before anything else imports msedge-tts.
import { webcrypto } from "node:crypto";
if (!globalThis.crypto) globalThis.crypto = webcrypto;
import express from "express";
import cors from "cors";
import path from "path";
import storyRouter from "./routes/story.js";
import reelsRouter from "./routes/reels.js";
import adminRouter, { seedFeaturedReel } from "./routes/admin.js";

const app = express();
const PORT = process.env.PORT || 4000;

// Restrict to the deployed frontend's origin(s) in production via FRONTEND_URL
// (comma-separated if you have more than one, e.g.
// "https://storyforge.vercel.app,https://staging.storyforge.vercel.app").
// Falls back to allowing any origin when unset, which is fine for local dev
// but should be set once this is publicly deployed.
const FRONTEND_URL = process.env.FRONTEND_URL;
const allowedOrigins = [
  // Stable production domain. Hardcoded so CORS works even if FRONTEND_URL
  // isn't set in the Railway environment.
  "https://story-forge-tau-three.vercel.app",
  ...(FRONTEND_URL
    ? FRONTEND_URL.split(",").map((s) => s.trim()).filter(Boolean)
    : []),
];

// Vercel also gives every individual deployment of this project its own
// unique URL (e.g. story-forge-<hash>-jbass-devs-projects.vercel.app) separate
// from the stable production domain above. This pattern matches both the
// stable production alias (story-forge-tau-three) and any per-deploy preview
// URL, so CORS doesn't break just because someone opens a deployment-specific
// link (which Vercel shows after every deploy) instead of the production URL.
const VERCEL_PATTERN = /^https:\/\/story-forge-[a-z0-9-]+\.vercel\.app$/;

app.use(
  cors({
    origin(origin, callback) {
      // Allow same-origin/non-browser requests (no Origin header) and any
      // whitelisted or StoryForge Vercel origin.
      if (!origin || allowedOrigins.includes(origin) || VERCEL_PATTERN.test(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
  })
);
app.use(express.json());

// Serve generated videos/images so the frontend can play/display them directly.
// no-store so regenerated output.mp4 files are always fetched fresh (not
// served from browser or CDN cache after a rebuild).
app.use("/media", express.static(path.join(process.cwd(), "storage"), {
  setHeaders(res) {
    res.setHeader("Cache-Control", "no-store");
  },
}));

app.use("/api/story", storyRouter);
app.use("/api/reels", reelsRouter);
app.use("/api/admin", adminRouter);

app.get("/api/health", (req, res) => res.json({ ok: true }));

async function start() {
  // Seed before accepting traffic so recruiters always see the dragon-delivery
  // reel on first load. Retry a few times in case Postgres isn't ready yet
  // (Railway can start the app container before the DB plugin is fully up).
  let seeded = false;
  for (let attempt = 1; attempt <= 5 && !seeded; attempt++) {
    try {
      const { id, r2 } = await seedFeaturedReel();
      console.log(`Pinned reel seeded (id=${id}, r2=${r2})`);
      seeded = true;
    } catch (err) {
      if (attempt < 5) {
        console.warn(`Seed attempt ${attempt} failed (${err.message}) - retrying in 2s`);
        await new Promise((r) => setTimeout(r, 2000));
      } else {
        console.warn(`Pinned reel seed skipped after ${attempt} attempts: ${err.message}`);
      }
    }
  }

  app.listen(PORT, () => {
    console.log(`StoryForge backend running on http://localhost:${PORT}`);
  });
}

start();
