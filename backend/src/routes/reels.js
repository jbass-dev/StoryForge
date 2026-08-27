import express from "express";
import { v4 as uuid } from "uuid";
import path from "path";
import fs from "fs";
import { generateStory, generateImagePrompts } from "../services/groq.js";
import { generateSceneImage } from "../services/pollinations.js";
import { synthesizeNarration } from "../services/tts.js";
import { pickMusicTrack } from "../services/music.js";
import { assembleVideo, renderSceneClip, sceneClipPath } from "../services/ffmpeg.js";
import { downloadImage } from "../utils/downloadImage.js";
import { uploadOutputVideo } from "../services/storage.js";
import { listReelsNewestFirst, getReel, insertReel, updateReel, deleteReel } from "../services/feedStore.js";

const router = express.Router();

const STORAGE_DIR = path.join(process.cwd(), "storage");

// Bundled placeholder still. If Pollinations fails outright even for the very
// first image, the reel falls back to this dark atmospheric panel instead of
// crashing - it reads as an intentional moody frame, never a broken image.
const FALLBACK_IMAGE = path.join(process.cwd(), "seed-assets", "fallback.jpg");

// Where a scene's start/end stills should be WRITTEN when generating fresh
// images for it (initial generation, or the target of a regenerate). Always
// the modern filenames - this is brand-new content, there's no legacy file
// to consider.
function scenePaths(workDir, sceneNumber) {
  return {
    imagePathStart: path.join(workDir, `scene-${sceneNumber}-start.jpg`),
    imagePathEnd: path.join(workDir, `scene-${sceneNumber}-end.jpg`),
  };
}

// Where to READ a scene's stills from when assembling/rendering a clip for
// a scene whose images aren't being refreshed right now. Falls back to the
// single legacy "scene-N.jpg" still used before the start/end pose-pair
// feature existed, so reels created with the old pipeline don't break the
// first time a sibling scene gets regenerated - without this, ffmpeg would
// error with "No such file" on every scene that's never been touched by the
// newer code. Using the same image for both ends just means that scene's
// clip has no motion-interpolation (a static-ish clip) instead of failing.
function resolveScenePaths(workDir, sceneNumber) {
  const { imagePathStart, imagePathEnd } = scenePaths(workDir, sceneNumber);
  if (fs.existsSync(imagePathStart) && fs.existsSync(imagePathEnd)) {
    return { imagePathStart, imagePathEnd };
  }
  const legacyPath = path.join(workDir, `scene-${sceneNumber}.jpg`);
  if (fs.existsSync(legacyPath)) {
    return { imagePathStart: legacyPath, imagePathEnd: legacyPath };
  }
  return { imagePathStart, imagePathEnd };
}

// In-memory job tracker for generation progress polling. Jobs are ephemeral
// (lost on server restart), which is fine - the finished reel itself is
// persisted to feed.json once the pipeline completes, and a half-finished
// job isn't something we need to recover after a crash/restart anyway.
const jobs = new Map();

// Per-reel lock so concurrent requests touching the same reel (e.g. clicking
// "regenerate" on several scenes in a row, or a regenerate landing while
// initial generation is still finishing) never run ffmpeg against the same
// output.mp4/feed.json at the same time. Windows locks files much more
// strictly than Linux/Mac - two ffmpeg processes opening the same output
// path for writing concurrently fails immediately with zero frames encoded
// ("Conversion failed!") rather than queueing, which is what was happening
// here. Each reel gets its own promise chain; unrelated reels still run in
// parallel.
const reelLocks = new Map();

function withReelLock(reelId, task) {
  const previous = reelLocks.get(reelId) || Promise.resolve();
  const next = previous.then(task, task);
  // Store a settled-tracking promise so a failed task doesn't permanently
  // wedge the lock for this reel - subsequent callers still wait for it to
  // finish, but the chain continues regardless of success/failure.
  reelLocks.set(
    reelId,
    next.catch(() => {})
  );
  return next;
}

function newJob(id, totalScenes) {
  const job = {
    id,
    status: "running", // running | done | error
    stage: "starting",
    currentScene: 0,
    totalScenes,
    reel: null,
    error: null,
  };
  jobs.set(id, job);
  return job;
}

// GET /api/reels - list generated reels for the feed
router.get("/", async (req, res) => {
  try {
    res.json(await listReelsNewestFirst());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load feed" });
  }
});

// GET /api/reels/:id - fetch a single reel (used by the scene-editing page)
router.get("/:id", async (req, res) => {
  try {
    const reel = await getReel(req.params.id);
    if (!reel) return res.status(404).json({ error: "Reel not found" });
    res.json(reel);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load reel" });
  }
});

// GET /api/reels/generate/:id/status - poll generation progress
router.get("/generate/:id/status", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Unknown job id" });
  const { reel, error, ...rest } = job;
  res.json({
    ...rest,
    reel: job.status === "done" ? reel : null,
    error: job.status === "error" ? error : null,
  });
});

// POST /api/reels/generate/start { prompt, genre }
// Kicks off the full pipeline in the background and returns immediately with
// a job id the frontend can poll for per-scene progress instead of staring
// at a static spinner for 1-2 minutes.
router.post("/generate/start", (req, res) => {
  const { prompt, genre = "cinematic" } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt is required" });

  const id = uuid();
  const job = newJob(id, 0);

  withReelLock(id, () => runGenerationPipeline(id, prompt, genre, job)).catch((err) => {
    console.error(err);
    job.status = "error";
    job.error = err.message;
  });

  res.json({ id });
});

async function runGenerationPipeline(id, prompt, genre, job) {
  const workDir = path.join(STORAGE_DIR, id);

  job.stage = "writing script";
  const story = await generateStory(prompt, genre);

  job.stage = "writing image prompts";
  // Defense in depth: if image-prompt generation ever fails outright, don't kill
  // the reel - fall back to an empty set so every scene uses its own visual
  // description (handled per-scene below). A finished reel beats a hard error.
  let image_prompts = [];
  try {
    ({ image_prompts } = await generateImagePrompts(story.scenes, story.style, story.characters));
  } catch (err) {
    console.warn(`Image-prompt generation failed (${err.message}) - falling back to per-scene visual descriptions; reel still proceeds.`);
    image_prompts = [];
  }

  job.totalScenes = story.scenes.length;

  // Narration doesn't depend on the images at all, so kick it off now and
  // let it run in the background while images generate sequentially below.
  const narrationChunks = story.scenes.map((s) => s.narration);
  const narrationPromise = synthesizeNarration(narrationChunks, story.narrator_gender);

  // Generate scene images sequentially with a small gap between requests -
  // Pollinations.ai's free endpoint rate-limits hard on concurrent bursts.
  // Each scene needs TWO stills (start/end pose) so ffmpeg can
  // motion-interpolate between them.
  const scenesWithImages = [];
  // Tracks the most recent successfully downloaded still, seeded with the
  // bundled placeholder, so a failed image can always reuse real art.
  let lastGoodStill = FALLBACK_IMAGE;
  for (let i = 0; i < story.scenes.length; i++) {
    const scene = story.scenes[i];
    job.currentScene = i + 1;
    job.stage = `generating scene ${i + 1} of ${story.scenes.length} art`;

    const imgPrompt = image_prompts.find((p) => p.scene === scene.scene) || image_prompts[i];
    // Groq occasionally returns fewer image_prompts entries than scenes (a
    // dropped scene in its JSON output) - rather than crash the whole reel
    // on one bad scene, fall back to the scene's own visual description so
    // generation can still finish, just with a slightly less tailored prompt
    // for that one scene.
    if (!imgPrompt) {
      console.warn(
        `Scene ${scene.scene}: Groq returned no image prompt for it - falling back to the scene's visual description.`
      );
    }
    const promptStart = imgPrompt?.prompt_start || scene.visual;
    const promptEnd = imgPrompt?.prompt_end || scene.visual;
    const { imagePathStart, imagePathEnd } = scenePaths(workDir, scene.scene);

    // Resilient image fetch: a single failed or rate-limited Pollinations image
    // must never crash the whole reel (that was surfacing a raw error on the
    // live showcase). On failure we reuse the last good still - or this scene's
    // start still for a failed end pose - so the scene just loses its motion,
    // not its art, and generation always completes.
    let urlStart = null;
    let urlEnd = null;
    let startOk = false;
    try {
      ({ url: urlStart } = await generateSceneImage(promptStart));
      await downloadImage(urlStart, imagePathStart);
      lastGoodStill = imagePathStart;
      startOk = true;
    } catch (err) {
      console.warn(`Scene ${scene.scene} start image failed (${err.message}) - reusing last good art so the reel still finishes.`);
      fs.mkdirSync(path.dirname(imagePathStart), { recursive: true });
      fs.copyFileSync(lastGoodStill, imagePathStart);
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));

    try {
      ({ url: urlEnd } = await generateSceneImage(promptEnd));
      await downloadImage(urlEnd, imagePathEnd);
      lastGoodStill = imagePathEnd;
    } catch (err) {
      console.warn(`Scene ${scene.scene} end image failed (${err.message}) - reusing this scene's start art.`);
      fs.mkdirSync(path.dirname(imagePathEnd), { recursive: true });
      fs.copyFileSync(startOk ? imagePathStart : lastGoodStill, imagePathEnd);
    }

    scenesWithImages.push({
      ...scene,
      imageUrlStart: urlStart,
      imageUrlEnd: urlEnd,
      imagePathStart,
      imagePathEnd,
    });

    if (i < story.scenes.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  job.stage = "finishing narration";
  const audioBuffer = await narrationPromise;
  let narrationAudioPath = null;
  if (audioBuffer) {
    narrationAudioPath = path.join(workDir, "narration.mp3");
    fs.writeFileSync(narrationAudioPath, audioBuffer);
  }

  const musicPath = pickMusicTrack();

  job.stage = "assembling video";
  const outputPath = path.join(workDir, "output.mp4");
  await assembleVideo({ scenes: scenesWithImages, outputPath, narrationAudioPath, musicPath, workDir });

  job.stage = "uploading video";
  // Upload to R2 (Cloudflare cloud storage) when configured so the reel
  // survives Railway restarts/redeploys and serves from R2's CDN instead of
  // our own backend. Falls back to the local /media static route in dev.
  const r2Url = await uploadOutputVideo(outputPath, id);

  const reel = {
    id,
    title: story.title,
    hook: story.hook,
    style: story.style,
    ending: story.ending,
    hashtags: story.hashtags,
    characters: story.characters || [],
    musicPath: musicPath || null,
    scenes: scenesWithImages.map(({ imagePathStart, imagePathEnd, ...rest }) => rest),
    videoUrl: r2Url || `/media/${id}/output.mp4`,
    hasNarration: Boolean(narrationAudioPath),
    hasMusic: Boolean(musicPath),
    createdAt: new Date().toISOString(),
  };

  await insertReel(reel);

  job.status = "done";
  job.stage = "done";
  job.reel = reel;
}

// POST /api/reels/:id/scenes/:sceneNumber/regenerate
// Re-generates just one scene's art (new Groq image prompt + new Pollinations
// stills) reusing the reel's stored character sheet and style so the
// character stays visually consistent, then re-assembles the full video
// (ffmpeg only outputs one file per reel, so a single-scene change still
// means a full re-encode) reusing the existing narration/music.
router.post("/:id/scenes/:sceneNumber/regenerate", async (req, res) => {
  const { id, sceneNumber } = req.params;
  const sceneNum = Number(sceneNumber);

  try {
    // Serialized per reel id: if another regenerate (or the initial
    // generation) is still writing this reel's output.mp4/clips, this
    // request waits its turn instead of racing it - two ffmpeg processes
    // writing the same output file at once is what was causing the
    // "Conversion failed!" 500s when multiple scenes were regenerated back
    // to back.
    const reel = await withReelLock(id, async () => {
      const reel = await getReel(id);
      if (!reel) {
        const err = new Error("Reel not found");
        err.statusCode = 404;
        throw err;
      }

      const sceneIndex = reel.scenes.findIndex((s) => s.scene === sceneNum);
      if (sceneIndex === -1) {
        const err = new Error("Scene not found");
        err.statusCode = 404;
        throw err;
      }

      const workDir = path.join(STORAGE_DIR, id);
      const targetScene = reel.scenes[sceneIndex];

      // Reuse the stored character sheet + style so the regenerated art
      // still matches everyone else's appearance across the rest of the reel.
      const { image_prompts } = await generateImagePrompts(
        [targetScene],
        reel.style,
        reel.characters || []
      );
      const imgPrompt = image_prompts[0];
      if (!imgPrompt) throw new Error("Failed to generate a new image prompt for this scene");

      const { imagePathStart, imagePathEnd } = scenePaths(workDir, sceneNum);

      // generateSceneImage() just builds a URL - the actual Pollinations
      // render (and its rate limiting) happens when downloadImage() fetches
      // it. Pollinations limits concurrent in-flight requests, not just
      // total volume, so running these two downloads in parallel triggered
      // 429s. Keep them sequential, but skip the artificial 1s pause the
      // full-generation pipeline uses between scenes (that was sized for
      // staggering 14+ requests, not 2) - that alone saves a full second
      // without re-tripping the limiter.
      const { url: urlStart } = await generateSceneImage(imgPrompt.prompt_start);
      await downloadImage(urlStart, imagePathStart);

      const { url: urlEnd } = await generateSceneImage(imgPrompt.prompt_end);
      await downloadImage(urlEnd, imagePathEnd);

      const updatedScene = {
        ...targetScene,
        imageUrlStart: urlStart,
        imageUrlEnd: urlEnd,
        imagePathStart,
        imagePathEnd,
      };
      reel.scenes[sceneIndex] = {
        ...targetScene,
        imageUrlStart: urlStart,
        imageUrlEnd: urlEnd,
      };

      // Force re-render ONLY this scene's clip - its images just changed, so
      // its previously-cached clip is stale. Every other scene's clip is left
      // on disk untouched; assembleVideo below will see those still exist
      // and skip re-rendering them, instead of re-running the expensive
      // motion-interpolation filter across the whole reel for a one-scene
      // change. Use the cheap "blend" motion mode here (vs. the heavier
      // "mci" mode used for full generation) so a single-scene edit doesn't
      // sit on the expensive filter for a result the rest of the reel won't
      // match exactly anyway - it's the slowest part of this request.
      await renderSceneClip({
        scene: updatedScene,
        outputPath: sceneClipPath(workDir, sceneNum),
        motionMode: "blend",
      });

      const scenesForAssembly = reel.scenes.map((s) => {
        const { imagePathStart, imagePathEnd } = resolveScenePaths(workDir, s.scene);
        return { ...s, imagePathStart, imagePathEnd };
      });

      const narrationAudioPath = path.join(workDir, "narration.mp3");
      const outputPath = path.join(workDir, "output.mp4");

      await assembleVideo({
        scenes: scenesForAssembly,
        outputPath,
        narrationAudioPath: reel.hasNarration ? narrationAudioPath : null,
        musicPath: reel.musicPath || null,
        workDir,
      });

      // Re-upload the freshly-rendered video so the R2 copy (if configured)
      // reflects the regenerated scene, not the stale pre-edit version.
      const r2Url = await uploadOutputVideo(outputPath, id);
      reel.videoUrl = r2Url || `/media/${id}/output.mp4`;

      await updateReel(reel);

      return reel;
    });

    res.json(reel);
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const reel = await getReel(id);
    if (!reel) return res.status(404).json({ error: "Reel not found" });

    await deleteReel(id);

    const reelDir = path.join(STORAGE_DIR, id);
    if (fs.existsSync(reelDir)) {
      fs.rmSync(reelDir, { recursive: true, force: true });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete reel" });
  }
});

export default router;
