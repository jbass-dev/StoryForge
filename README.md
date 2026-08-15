# StoryForge

**[▶ Live demo](https://story-forge-tau-three.vercel.app)** — one prompt in, a finished vertical reel out.

<img width="1300" height="851" alt="StoryForge live app" src="https://github.com/user-attachments/assets/543da502-9f82-4bce-9fb3-56caa72f8534" />

An AI-generated short-drama video app (a portfolio project). You give it a one-line pitch and a genre; it writes a script, generates comic-style scene art, narrates it, burns in captions, scores it with background music, and stitches everything into a single vertical MP4 that plays start to finish. Below the player, the reel's 5-10 scenes are listed and any scene can be regenerated individually. Every piece of the pipeline runs on a free tier or self-hosted tool - no paid APIs required.


## Pipeline

```
User prompt
   -> Groq (GPT-OSS 120B): generates a structured JSON script (title, hook,
      style, narrator gender, scenes with visual/narration/camera/duration,
      ending, hashtags). Targets ~60 seconds total (7-9 scenes, 7-10s each).
   -> Groq: turns each scene into a detailed, cinematic image-generation prompt
   -> Pollinations.ai: free, no-key image generation per scene (generated
      sequentially with backoff/retry to respect its rate limits)
   -> Piper TTS (optional, free, self-hosted): narration audio for the full
      script, with the narrator's voice gender chosen by Groq based on the
      protagonist. If not set up, the app falls back to silent/caption-only
      mode instead of failing.
   -> FFmpeg:
        - Ken Burns pan/zoom on every scene image (alternating direction)
        - burned-in captions per scene, drawn from that scene's narration text
        - narration audio and/or a randomly-picked background music track
          mixed in (music ducked under narration)
        - concatenated into a single 1080x1920 vertical MP4
   -> Feed: Next.js vertical scroll-snap player, like a Reels/TikTok feed,
      with a tap-to-mute control on each video
```

## Project structure

```
backend/    Node/Express API - runs the generation pipeline
frontend/   Next.js app - vertical feed + generate screen
```

## Setup

### 1. Get a Groq key (required, free)

https://console.groq.com/keys — sign up, create a key, no credit card
required. This powers script + image-prompt generation.

### 2. Set up Piper TTS (optional, free, self-hosted narration)

No signup at all - this runs entirely on your machine.

1. Download the Windows binary from
   https://github.com/rhasspy/piper/releases and unzip it into
   `backend/piper/` so that `backend/piper/piper.exe` exists alongside its
   DLLs and the `espeak-ng-data` folder.
2. Download a female and male voice model from
   https://github.com/rhasspy/piper/blob/master/VOICES.md - this project
   uses `en_US-amy-medium` (female) and `en_US-ryan-medium` (male). Each
   voice needs both its `.onnx` file and matching `.onnx.json` file. Put all
   four files in `backend/piper/voices/`.
3. Point `PIPER_EXECUTABLE`, `PIPER_VOICE_FEMALE`, and `PIPER_VOICE_MALE` in
   `.env` at those files (already set if you used the paths above).

If you skip this, reels still generate, just with captions and music but no
spoken narration.

(We tried ElevenLabs and Google Cloud TTS first - both either need a paid
plan or a credit card for real use, so Piper is the only option here with
zero strings attached.)

### 3. Add background music (optional, free)

1. Download a few short instrumental tracks (mp3) from
   https://pixabay.com/music/ - no signup required, free for any use, no
   attribution needed. Cinematic/ambient/trailer-style tracks work best
   since they won't clash with narration.
2. Drop them into `backend/music/`.
3. `MUSIC_DIR` in `.env` already points at that folder. One track is picked
   at random per reel and mixed in quietly under the narration.

If the folder's empty, reels generate without music.

### 4. Backend

```bash
cd backend
cp .env.example .env
# paste your GROQ_API_KEY into .env (and set up Piper/music above if you want them)
npm install
npm run dev
```

Runs on http://localhost:4000.

### 5. Frontend

```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

Runs on http://localhost:3000. Open it, tap **+ New**, type a one-line pitch,
pick a genre, and generate. Reels run ~60 seconds long (7-9 scenes), so
generation takes roughly 1-2 minutes (sequential image generation + video
assembly are the slow steps). The reel then shows up at the top of the feed.

### Genres

cinematic, romance, fantasy, revenge, horror, comedy, sci-fi,
alternate-history, survival, mystery, space, cyberpunk, time-travel,
mythology, post-apocalypse, true-crime, inspirational, ai-stories, what-if

Picking **what-if** swaps the prompt box placeholder to example "what if"
pitches (e.g. "What if Rome never fell?", "What if AI ruled Earth?") since
that framing tends to produce the most varied, generatable story ideas.

## Features

- **Script generation** - Groq writes title, hook, per-scene visuals,
  narration, camera direction, scene durations, an ending, and hashtags as
  structured JSON.
- **Scene art** - Groq turns each scene into a detailed cinematic image
  prompt; Pollinations.ai renders it for free, no API key.
- **Gender-matched narration** - Groq decides the narrator's voice based on
  the story's protagonist; Piper TTS synthesizes it locally and for free.
- **Ken Burns motion** - every static scene image gets a subtle pan/zoom via
  FFmpeg's `zoompan` filter instead of sitting still.
- **Burned-in captions** - each scene's narration line is rendered as
  on-screen text (FFmpeg `drawtext`), so reels work even muted.
- **Background music** - a random royalty-free track is mixed in quietly
  under the narration via FFmpeg's `amix`.
- **TikTok-style feed** - vertical scroll-snap video feed (Next.js) with a
  tap-to-mute control per video.

## Notes / known limits

- Pollinations.ai images are free but lower fidelity than paid models
  (DALL·E, Stability, Kling). Swapping in a paid image API is a drop-in
  change in `backend/src/services/pollinations.js`.
- Scenes use a Ken Burns pan/zoom effect (FFmpeg `zoompan`), not true
  AI-generated video motion. Real image-to-video (Kling, Runway, Stable Video
  Diffusion) can be swapped into `backend/src/services/ffmpeg.js`'s pipeline
  once you're ready to pay for it or self-host a model.
- Narration is synthesized as one continuous track over the full script and
  trimmed to fit, rather than timed per-scene - so spoken audio and the
  per-scene captions are approximately, not frame-exactly, in sync.
- Captions need `CAPTION_FONT_PATH` to resolve to a real font file (defaults
  to Windows' built-in Arial Bold); if that file isn't found, captions are
  skipped automatically rather than breaking generation.
- No auth, likes, comments, or following yet - the feed currently just lists
  every reel ever generated, newest first, from Postgres (or
  `backend/storage/feed.json` locally if `DATABASE_URL` isn't set).
- Avoid prompting for copyrighted characters/franchises - keep story ideas
  original to stay clear of any IP issues.

## Suggested next features (portfolio polish)

- User accounts (Firebase Auth or NextAuth) + per-user reel ownership
- Likes, comments, follows, search
- Per-scene generation progress (polling/SSE) instead of a static
  "Generating..." button during the 1-2 minute pipeline run
- A fixed character/style sheet passed into every image prompt for visual
  consistency of recurring characters across scenes
- Swap Pollinations for Stability/DALL·E and add a "regenerate scene" button
- Lazy-load/pause feed videos outside the viewport (IntersectionObserver)
  instead of autoplaying every video in the feed at once

## Deployment

Three pieces, three providers: **Vercel** (frontend), **Railway** (backend +
Postgres), **Cloudflare R2** (generated video storage). Local dev is
unaffected - all of this is opt-in via env vars, and everything still falls
back to the original local-disk/flat-file behavior if you skip a piece.

### 1. Cloudflare R2 (cloud storage for generated videos)

1. In the Cloudflare dashboard, go to **R2** and create a bucket (e.g.
   `storyforge-media`).
2. Open the bucket's **Settings** tab and enable **Public Access** - this
   gives you a public `https://pub-xxxxxxxx.r2.dev` base URL. (For a custom
   domain instead, map one to the bucket and use that as the public URL.)
3. Go to **R2 → Manage API Tokens** and create a token with **Object
   Read & Write** permission scoped to that bucket. Note the Access Key ID,
   Secret Access Key, and your Account ID (shown in the R2 dashboard sidebar).
4. You'll plug these into the backend's env vars in step 3 below:
   `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
   `R2_BUCKET_NAME`, `R2_PUBLIC_URL` (the public base URL from step 2, no
   trailing slash).

If you skip this entirely, generated videos are just served from the
backend's local disk via `/media` - fine for local dev, but on Railway
they won't survive a redeploy/restart.

### 2. Railway (backend + Postgres)

1. Create a new Railway project from this repo. When prompted for the
   service's root directory, set it to `backend`.
2. Add a **Postgres** plugin to the project (Railway → New → Database →
   PostgreSQL). Railway automatically injects `DATABASE_URL` into every
   other service in the same project, including your backend - no manual
   wiring needed. The backend creates its `reels` table itself on first
   request.
3. On the backend service, set these environment variables:
   - `GROQ_API_KEY` (required - from https://console.groq.com/keys)
   - `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
     `R2_BUCKET_NAME`, `R2_PUBLIC_URL` (from step 1)
   - `FRONTEND_URL` - set this once you have your Vercel URL (step 3),
     e.g. `https://storyforge.vercel.app`. CORS allows all origins until
     this is set, which is fine to start with but worth locking down.
   - Optionally `MUSIC_DIR=./music` if you've committed royalty-free
     tracks to `backend/music/` (see Setup above).
4. Railway sets `PORT` automatically; the app already reads
   `process.env.PORT`, so no change needed there.
5. Deploy. Railway's Linux build environment downloads the Linux build of
   `ffmpeg-static` automatically - no extra setup needed for FFmpeg.
6. Note the public URL Railway gives the backend service (something like
   `https://storyforge-backend.up.railway.app`) - you'll need it for the
   frontend's env var next.

### 3. Vercel (frontend)

1. Import this repo into Vercel. Set the project's **Root Directory** to
   `frontend`. Vercel auto-detects Next.js - no other build config needed.
2. Add an environment variable: `NEXT_PUBLIC_API_BASE_URL` = your Railway
   backend's public URL from step 2.6 (no trailing slash).
3. Deploy. Once it's live, go back to Railway and set `FRONTEND_URL` to
   this Vercel URL so CORS is locked down to just your frontend.

### Notes

- Scene art (the JPEGs ffmpeg uses as ffmpeg input) stays on Pollinations'
  own CDN - the frontend reads `imageUrlStart`/`imageUrlEnd` directly from
  there, so there's nothing to upload for those.
- The homepage's pinned "featured" reel plays directly from that reel's own
  `videoUrl` (its R2-hosted MP4) - same as any other reel in the feed, just
  pinned to the top via `PINNED_REEL_ID` in `frontend/app/page.tsx`. An
  admin-only endpoint (`POST /api/admin/seed-featured`, see
  `backend/src/routes/admin.js`) idempotently seeds that pinned reel from
  bundled assets in `backend/seed-assets/` on a fresh deploy/database, so a
  visitor sees a fully-rendered reel immediately instead of an empty feed.
- Without R2 configured, regenerating a scene works fine while the Railway
  container stays up, but a redeploy/restart wipes local disk - any reel
  generated before that point loses its video file (the Postgres row
  survives, just not the on-disk MP4) unless R2 was set up.
