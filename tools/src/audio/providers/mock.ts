import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeSafeFileStem } from "../utils.js";
import type { AudioGenerationRequest, AudioProvider, GeneratedAudioCandidate } from "../types.js";

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

function makeSilentWav(durationSeconds: number): Buffer {
  const sampleRate = 44_100;
  const channels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const sampleCount = Math.max(1, Math.floor(sampleRate * durationSeconds));
  const dataSize = sampleCount * channels * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  return buffer;
}

export const mockProvider: AudioProvider = {
  name: "mock",
  async generate(request: AudioGenerationRequest): Promise<GeneratedAudioCandidate[]> {
    await mkdir(request.outputDir, { recursive: true });

    const candidates: GeneratedAudioCandidate[] = [];
    const fileStem = makeSafeFileStem(request.target);
    const firstIndex = await getNextIndex(request.outputDir, fileStem, ".wav");

    for (let i = 0; i < request.count; i += 1) {
      const variant = request.variants[i % request.variants.length];
      const index = firstIndex + i;
      const filename = `${fileStem}_${String(index).padStart(2, "0")}_${variant.slug}.wav`;
      const candidatePath = path.join(request.outputDir, filename);
      const duration = request.kind === "sfx" ? Math.min(request.durationSeconds, 1) : request.durationSeconds;

      await writeFile(candidatePath, makeSilentWav(duration));

      candidates.push({
        index,
        variant,
        filename,
        path: candidatePath,
        provider: "mock",
        mock: true,
        durationSeconds: duration,
      });
    }

    return candidates;
  },
};
