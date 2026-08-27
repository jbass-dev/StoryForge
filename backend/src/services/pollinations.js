// Pollinations.ai - free, no API key required.
// Docs: https://pollinations.ai/

// Default still size trimmed from 1080x1920: Pollinations' free endpoint is
// much slower and rate-limits far harder on large images, and the stills
// are scaled/cropped to the render resolution anyway, so a smaller source
// means faster generation and dramatically fewer failed fetches.
export function buildImageUrl(prompt, { width = 720, height = 1280, seed } = {}) {
  const base = process.env.POLLINATIONS_BASE_URL || "https://image.pollinations.ai/prompt";
  const encoded = encodeURIComponent(prompt);
  const params = new URLSearchParams({
    width: String(width),
    height: String(height),
    nologo: "true",
  });
  if (seed !== undefined) params.set("seed", String(seed));
  return `${base}/${encoded}?${params.toString()}`;
}

// Pollinations generates on-demand at the URL itself, so "generating" an
// image for a scene just means building the right URL. We still expose this
// as an async function so it's a drop-in swap for a real generation API later.
export async function generateSceneImage(prompt, opts) {
  const url = buildImageUrl(prompt, opts);
  return { url };
}
