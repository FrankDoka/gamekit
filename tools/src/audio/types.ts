export type AudioKind = "bgm" | "sfx";

export type AudioProviderName = "mock" | "elevenlabs";

export interface AudioPromptVariant {
  slug: string;
  label: string;
  prompt: string;
}

export interface AudioGenerationRequest {
  provider: AudioProviderName;
  kind: AudioKind;
  target: string;
  count: number;
  durationSeconds: number;
  promptInfluence: number;
  loop: boolean;
  modelId: string;
  outputDir: string;
  variants: AudioPromptVariant[];
  allowPaidCall: boolean;
}

export interface GeneratedAudioCandidate {
  index: number;
  variant: AudioPromptVariant;
  filename: string;
  path: string;
  provider: AudioProviderName;
  mock: boolean;
  durationSeconds: number;
}

export interface AudioProvider {
  name: AudioProviderName;
  generate(request: AudioGenerationRequest): Promise<GeneratedAudioCandidate[]>;
}
