import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeSafeFileStem } from "../utils.js";
import type { AudioGenerationRequest, AudioProvider, GeneratedAudioCandidate } from "../types.js";

const SOUND_GENERATION_URL = "https://api.elevenlabs.io/v1/sound-generation";

async function getNextIndex(outputDir: string, fileStem: string, extension: string): Promise<number> {
  try {
    const entries = await readdir(outputDir);
    const indexes = entries
      .map((entry) => entry.match(new RegExp(`^${fileStem}_(\\d+)_.+\\${extension}$`)))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map((match) => Number(match[1]))
      .filter((value) => Number.isInteger(value));
    return indexes.length > 0 ? Math.max(...indexes) + 1 : 1;
  } catch {
    return 1;
  }
}

export const elevenLabsProvider: AudioProvider = {
  name: "elevenlabs",
  async generate(request: AudioGenerationRequest): Promise<GeneratedAudioCandidate[]> {
    if (!request.allowPaidCall) {
      throw new Error(
        "ElevenLabs generation is blocked unless --allow-paid-call is provided after explicit owner approval.",
      );
    }

    if (!process.env.ELEVENLABS_API_KEY) {
      throw new Error("ELEVENLABS_API_KEY is not available in this process.");
    }

    if (request.kind !== "sfx") {
      throw new Error("ElevenLabs real calls are currently enabled only for SFX test generation.");
    }

    await mkdir(request.outputDir, { recursive: true });

    const candidates: GeneratedAudioCandidate[] = [];
    const fileStem = makeSafeFileStem(request.target);
    const firstIndex = await getNextIndex(request.outputDir, fileStem, ".mp3");

    for (let i = 0; i < request.count; i += 1) {
      const variant = request.variants[i % request.variants.length];
      const index = firstIndex + i;
      const filename = `${fileStem}_${String(index).padStart(2, "0")}_${variant.slug}.mp3`;
      const candidatePath = path.join(request.outputDir, filename);

      const response = await fetch(SOUND_GENERATION_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
        },
        body: JSON.stringify({
          text: variant.prompt,
          duration_seconds: request.durationSeconds,
          prompt_influence: request.promptInfluence,
          loop: request.loop,
          model_id: request.modelId,
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`ElevenLabs generation failed: ${response.status} ${response.statusText} ${body}`);
      }

      const audio = Buffer.from(await response.arrayBuffer());
      await writeFile(candidatePath, audio);

      candidates.push({
        index,
        variant,
        filename,
        path: candidatePath,
        provider: "elevenlabs",
        mock: false,
        durationSeconds: request.durationSeconds,
      });
    }

    return candidates;
  },
};
