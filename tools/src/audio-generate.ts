import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { assetsRoot } from "./toolkit-config.js";
import { getPromptVariants } from "./audio/prompts.js";
import { elevenLabsProvider } from "./audio/providers/elevenlabs.js";
import { mockProvider } from "./audio/providers/mock.js";
import type { AudioGenerationRequest, AudioKind, AudioProviderName, GeneratedAudioCandidate } from "./audio/types.js";

const DEFAULT_OWNER_AUDIO_ROOT = path.join(assetsRoot(), "audio", "generated");

interface CliOptions {
  kind: AudioKind;
  target: string;
  count: number;
  provider: AudioProviderName;
  durationSeconds: number;
  promptInfluence: number;
  loop: boolean;
  modelId: string;
  outputRoot: string;
  allowPaidCall: boolean;
}

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  pnpm audio:generate -- bgm mossgrove_edge --count 5 --provider mock",
      "  pnpm audio:generate -- sfx crystal_bloop_move --count 5 --provider mock --duration 1",
      "",
      "Options:",
      "  --provider mock|elevenlabs   Default: mock",
      "  --count <number>             Default: 5",
      "  --duration <seconds>         Default: 75 for bgm, 1 for sfx",
      "  --prompt-influence <number>  Default: 0.5",
      "  --loop                       Request loopable audio. Default: false",
      "  --model <id>                 Default: eleven_text_to_sound_v2",
      "  --out <path>                 Default: Z:/Assets/audio/generated",
      "  --allow-paid-call            Required for non-mock providers",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): CliOptions {
  if (argv[0] === "--") {
    argv = argv.slice(1);
  }

  const [kindArg, target, ...rest] = argv;
  if (kindArg !== "bgm" && kindArg !== "sfx") {
    usage();
  }
  if (!target) {
    usage();
  }

  let provider: AudioProviderName = "mock";
  let count = 5;
  let durationSeconds = kindArg === "bgm" ? 75 : 1;
  let promptInfluence = 0.5;
  let loop = false;
  let modelId = "eleven_text_to_sound_v2";
  let outputRoot = DEFAULT_OWNER_AUDIO_ROOT;
  let allowPaidCall = false;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const next = rest[i + 1];

    if (arg === "--provider") {
      if (next !== "mock" && next !== "elevenlabs") {
        throw new Error("--provider must be mock or elevenlabs.");
      }
      provider = next;
      i += 1;
      continue;
    }

    if (arg === "--count") {
      count = Number(next);
      if (!Number.isInteger(count) || count < 1 || count > 20) {
        throw new Error("--count must be an integer from 1 to 20.");
      }
      i += 1;
      continue;
    }

    if (arg === "--duration") {
      durationSeconds = Number(next);
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 180) {
        throw new Error("--duration must be greater than 0 and no more than 180 seconds.");
      }
      i += 1;
      continue;
    }

    if (arg === "--prompt-influence") {
      promptInfluence = Number(next);
      if (!Number.isFinite(promptInfluence) || promptInfluence < 0 || promptInfluence > 1) {
        throw new Error("--prompt-influence must be from 0 to 1.");
      }
      i += 1;
      continue;
    }

    if (arg === "--loop") {
      loop = true;
      continue;
    }

    if (arg === "--model") {
      if (!next) {
        throw new Error("--model requires a model id.");
      }
      modelId = next;
      i += 1;
      continue;
    }

    if (arg === "--out") {
      if (!next) {
        throw new Error("--out requires a path.");
      }
      outputRoot = next;
      i += 1;
      continue;
    }

    if (arg === "--allow-paid-call") {
      allowPaidCall = true;
      continue;
    }

    usage();
  }

  return {
    kind: kindArg,
    target,
    count,
    provider,
    durationSeconds,
    promptInfluence,
    loop,
    modelId,
    outputRoot,
    allowPaidCall,
  };
}

function getProvider(name: AudioProviderName) {
  if (name === "mock") {
    return mockProvider;
  }
  return elevenLabsProvider;
}

function resolveOutputDir(options: CliOptions): string {
  return path.resolve(options.outputRoot, options.kind, options.target);
}

function formatPromptLog(request: AudioGenerationRequest, candidates: GeneratedAudioCandidate[]): string {
  const now = new Date().toISOString();
  const paidStatus = request.provider === "mock" ? "mock run; no API call, no credits spent" : "paid/API run";

  return [
    "# Audio Candidate Prompt Log",
    "",
    `- Date: ${now}`,
    `- Provider: ${request.provider}`,
    `- Kind: ${request.kind}`,
    `- Target: ${request.target}`,
    `- Count: ${request.count}`,
    `- Duration seconds: ${request.durationSeconds}`,
    `- Prompt influence: ${request.promptInfluence}`,
    `- Loop: ${request.loop}`,
    `- Model: ${request.modelId}`,
    `- Output dir: ${request.outputDir}`,
    `- API/credit status: ${paidStatus}`,
    `- License status: prototype candidates; re-check provider terms before acceptance`,
    "",
    "## Candidates",
    "",
    ...candidates.flatMap((candidate) => [
      `### ${String(candidate.index).padStart(2, "0")} - ${candidate.variant.label}`,
      "",
      `- File: ${candidate.filename}`,
      `- Mock: ${candidate.mock ? "yes" : "no"}`,
      `- Duration seconds: ${candidate.durationSeconds}`,
      "",
      "Prompt:",
      "",
      "```text",
      candidate.variant.prompt,
      "```",
      "",
    ]),
  ].join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const variants = getPromptVariants(options.kind, options.target);
  const outputDir = resolveOutputDir(options);
  const provider = getProvider(options.provider);

  const request: AudioGenerationRequest = {
    provider: options.provider,
    kind: options.kind,
    target: options.target,
    count: options.count,
    durationSeconds: options.durationSeconds,
    promptInfluence: options.promptInfluence,
    loop: options.loop,
    modelId: options.modelId,
    outputDir,
    variants,
    allowPaidCall: options.allowPaidCall,
  };

  if (request.provider !== "mock" && !request.allowPaidCall) {
    throw new Error("Non-mock generation requires --allow-paid-call after explicit owner approval.");
  }

  await mkdir(outputDir, { recursive: true });
  const candidates = await provider.generate(request);
  await writeFile(path.join(outputDir, "prompt-log.md"), formatPromptLog(request, candidates));

  console.log(`Generated ${candidates.length} ${request.provider} candidate(s).`);
  console.log(`Output: ${outputDir}`);
  console.log(`Prompt log: ${path.join(outputDir, "prompt-log.md")}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
