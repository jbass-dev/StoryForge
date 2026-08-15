import fetch from "node-fetch";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

async function callGroq(systemPrompt, userPrompt) {
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.9,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Groq API error (${res.status}): ${text}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  return JSON.parse(content);
}

const STORY_SYSTEM_PROMPT = `You are an expert AI story-to-short-form video planner.
Your job is to convert user ideas into structured short-form video scripts for a TikTok/Reels-style app.

Rules:
- Output ONLY valid JSON.
- No markdown, no explanations, no extra text.
- The JSON must match the schema exactly.
- Each story must be optimized for short-form vertical video (hook in first 2-3 seconds).
- Scenes must be visual-first (what the viewer sees, not abstract ideas).
- Keep scenes simple, cinematic, and visually clear.
- Each scene should be 7-10 seconds long, with 7-9 scenes per story, for a
  total video length of roughly 55-65 seconds.
- Write enough narration per scene (roughly 3-5 sentences, ~20-30 words) to
  naturally fill that scene's duration when read aloud at a normal speaking
  pace - don't leave the scene's audio finishing way before the visual
  duration is up.
- Make content engaging and emotionally compelling (avoid copyrighted characters/franchises).
- Decide the narrator's voice gender based on the protagonist/POV of the story (e.g. a story centered on a woman should be narrated by a female voice).
- Define every recurring character once with a fixed, specific physical
  description (age, hair, build, clothing, distinguishing features) that
  will be reused verbatim in every scene they appear in, so they look the
  same from scene to scene instead of changing appearance randomly.`;

export async function generateStory(userPrompt, genre = "cinematic") {
  const prompt = `Create a short-form vertical video story based on this idea:

"${userPrompt}"

Genre/tone: ${genre}
Target platform: short-form vertical video
Audience: general viewers

Return a JSON object with this exact structure:
{
  "title": "string",
  "hook": "string",
  "style": "string",
  "narrator_gender": "male" or "female",
  "characters": [
    { "name": "string", "appearance": "specific, reusable physical description: age, hair, build, clothing, distinguishing features" }
  ],
  "scenes": [
    { "scene": 1, "visual": "string", "narration": "string", "camera": "string", "duration_seconds": 8, "characters_present": ["string"] }
  ],
  "ending": "string",
  "hashtags": ["string"]
}`;

  return callGroq(STORY_SYSTEM_PROMPT, prompt);
}

// Rendering target is comic-book/manga panel art (VibeShort-style motion
// comic) instead of photorealistic cinematic stills - bold ink outlines,
// flat-to-dramatic comic shading, halftone/screentone texture, dynamic
// panel framing. The genre/mood (romance, horror, sci-fi, etc.) still comes
// through in lighting, color palette, and composition - it just renders as
// a comic panel instead of a photo.
//
// Each scene gets TWO prompts (start/end) instead of one. The pipeline
// generates both as separate stills and motion-interpolates between them in
// ffmpeg, faking actual movement within a scene instead of just panning over
// one flat image - free/local, no AI video model required. The two prompts
// need to depict the SAME moment continuing forward a beat (same character,
// outfit, setting, art style, panel framing) with only pose/expression/minor
// camera drift changing - large jumps between start and end make the
// interpolation look like a glitchy crossfade instead of motion.
const IMAGE_PROMPT_SYSTEM_PROMPT = `You are an expert comic-book/manga panel prompt engineer for AI image generation models.
Your job is to convert video scene descriptions into highly detailed image generation prompts for comic-style panel art (motion-comic aesthetic, not photorealistic).

Each scene needs TWO prompts - "prompt_start" and "prompt_end" - depicting the same moment a beat apart, used to fake motion by interpolating between the two generated images.

Rules:
- Output ONLY valid JSON.
- No explanations or markdown.
- Every prompt must render as a single comic-book/manga style illustrated panel: bold ink outlines, dynamic comic shading and coloring, halftone or screentone texture where appropriate, dramatic comic-panel framing and composition.
- Explicitly steer away from photorealism, photography, and 3D-render look - this is illustrated panel art.
- Do not include speech bubbles, dialogue text, captions, or lettering of any kind in the image itself - narration/dialogue is added separately outside the image.
- prompt_start and prompt_end must keep the same character(s), outfit, setting, lighting, color palette, art style, and panel framing/angle - only change pose, expression, gesture, or very slight camera drift, as if it's the next beat of the same continuous action. Do not change the scene, camera angle dramatically, or introduce/remove characters between start and end.
- Focus on visual details: lighting, mood, environment, camera/panel angle, color palette.
- Make prompts suitable for vertical short-form video frames (9:16 composition).
- Always include panel angle, lighting, comic art style descriptors, environment detail, and mood.
- For every character listed as present in a scene, include their exact
  physical description from the character sheet verbatim in both prompt_start
  and prompt_end - word-for-word, not paraphrased - so the same character
  looks identical across every scene's generated images.`;

export async function generateImagePrompts(scenes, style = "cinematic", characters = []) {
  const prompt = `Convert the following video scenes into AI image generation prompts for comic-book/manga style panel art.
Genre/mood to carry through the comic art (lighting, palette, composition - NOT photorealism): ${style}

Character sheet (reuse these descriptions verbatim for any character present in a scene):
${JSON.stringify(characters, null, 2)}

Scenes:
${JSON.stringify(scenes, null, 2)}

Return JSON in this format:
{
  "image_prompts": [
    { "scene": 1, "prompt_start": "string", "prompt_end": "string", "negative_prompt": "photorealistic, photo, 3d render, blurry, low quality, distorted, text, speech bubble, watermark" }
  ]
}`;

  return callGroq(IMAGE_PROMPT_SYSTEM_PROMPT, prompt);
}
