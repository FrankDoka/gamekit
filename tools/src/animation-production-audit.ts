import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderAnimationClientModule } from "./animation-sync-client";

type CandidateRun = {
  kind?: string;
  sourceKind?: string;
  sourcePath?: string;
  sourceArtProvider?: string | null;
  provider?: string | null;
  model?: string | null;
  paidRunApprovedByOwner?: boolean;
  status?: string;
  decision?: string;
  normalized?: boolean;
  reports?: Record<string, string | null | undefined>;
  audit?: { failures?: string[]; warnings?: string[]; summary?: Record<string, unknown> };
  artifacts?: Record<string, string | null | undefined>;
};

type RequirementStatus = "pass" | "partial" | "missing";

type Requirement = {
  id: string;
  status: RequirementStatus;
  evidence: string[];
  notes?: string;
};

const ROOT = process.cwd();

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function walkFiles(root: string, predicate: (filePath: string) => boolean, out: string[] = []): string[] {
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walkFiles(full, predicate, out);
    else if (predicate(full)) out.push(full);
  }
  return out;
}

function rel(filePath: string): string {
  return path.relative(ROOT, filePath).split(path.sep).join("/");
}

function packageScripts(): Record<string, string> {
  return readJson<{ scripts?: Record<string, string> }>(path.join(ROOT, "package.json")).scripts ?? {};
}

function scriptRequirement(id: string, scripts: Record<string, string>, names: string[]): Requirement {
  const missing = names.filter((name) => !scripts[name]);
  return {
    id,
    status: missing.length ? "missing" : "pass",
    evidence: names.filter((name) => scripts[name]).map((name) => `package script: ${name}`),
    notes: missing.length ? `Missing package scripts: ${missing.join(", ")}` : undefined,
  };
}

function artifactRequirement(id: string, paths: string[], notes?: string): Requirement {
  const resolveArtifact = (item: string): string => (path.isAbsolute(item) ? item : path.join(ROOT, item));
  const existing = paths.filter((item) => existsSync(resolveArtifact(item)));
  const status: RequirementStatus = existing.length === paths.length ? "pass" : existing.length ? "partial" : "missing";
  return {
    id,
    status,
    evidence: existing,
    notes: status === "pass" ? notes : `Missing: ${paths.filter((item) => !existing.includes(item)).join(", ")}`,
  };
}

function candidateRuns(): Array<{ path: string; run: CandidateRun }> {
  return walkFiles(path.join(ROOT, "tmp"), (filePath) => path.basename(filePath) === "candidate-run.json")
    .map((filePath) => ({ path: filePath, run: readJson<CandidateRun>(filePath) }))
    .sort((a, b) => rel(a.path).localeCompare(rel(b.path)));
}

function hasCompleteCandidate(run: CandidateRun): boolean {
  return Boolean(
    run.normalized &&
      run.artifacts?.selectedContact &&
      run.artifacts?.selectedPreviewGif &&
      run.artifacts?.runtimeSheet &&
      run.artifacts?.runtimeMetadata &&
      run.artifacts?.runtimeFinalization &&
      run.reports?.cleanup &&
      run.reports?.audit,
  );
}

function isRealProviderSource(run: CandidateRun): boolean {
  if (run.sourceKind !== "local-video") return false;
  if (run.provider || run.model || run.sourceArtProvider) return true;
  if (run.paidRunApprovedByOwner) return true;
  const sourcePath = String(run.sourcePath ?? "").replace(/\\/g, "/").toLowerCase();
  return !sourcePath.includes("animation-video-fixtures") && !sourcePath.includes("simple-flat-chroma");
}

function runtimeIndexRequirement(): Requirement {
  const indexPath = path.join(ROOT, "client/public/assets/index.json");
  const generatedPath = path.join(ROOT, "client/src/config/animation-assets.ts");
  if (!existsSync(indexPath) || !existsSync(generatedPath)) {
    return {
      id: "promoted runtime registry and generated Phaser config",
      status: existsSync(indexPath) || existsSync(generatedPath) ? "partial" : "missing",
      evidence: [indexPath, generatedPath].filter(existsSync).map(rel),
      notes: "Both client/public/assets/index.json and client/src/config/animation-assets.ts are required.",
    };
  }
  try {
    const expected = renderAnimationClientModule(readJson(indexPath));
    const actual = readFileSync(generatedPath, "utf8").replace(/\r\n/g, "\n");
    return {
      id: "promoted runtime registry and generated Phaser config",
      status: expected === actual ? "pass" : "partial",
      evidence: [rel(indexPath), rel(generatedPath)],
      notes: expected === actual ? "Generated config matches promoted registry." : "Generated config is stale; run pnpm animation-sync-client.",
    };
  } catch (error) {
    return {
      id: "promoted runtime registry and generated Phaser config",
      status: "partial",
      evidence: [rel(indexPath), rel(generatedPath)],
      notes: error instanceof Error ? error.message : String(error),
    };
  }
}

function markdown(requirements: Requirement[], candidates: Array<{ path: string; run: CandidateRun }>): string {
  const lines = [
    "# Animation Production Readiness Audit",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Requirements",
    "",
    "| Requirement | Status | Evidence | Notes |",
    "| --- | --- | --- | --- |",
  ];
  for (const requirement of requirements) {
    lines.push(
      `| ${requirement.id} | ${requirement.status} | ${requirement.evidence.map((item) => `\`${item}\``).join("<br>") || "-"} | ${requirement.notes ?? ""} |`,
    );
  }
  lines.push("", "## Candidate Runs", "", "| Candidate | Source | Provider | Complete Package | Audit |", "| --- | --- | --- | --- | --- |");
  for (const { path: candidatePath, run } of candidates) {
    const provider = [run.provider, run.model, run.sourceArtProvider].filter(Boolean).join(" / ") || "local/no-provider";
    const audit = [
      `failures ${(run.audit?.failures ?? []).length}`,
      `warnings ${(run.audit?.warnings ?? []).length}`,
    ].join(", ");
    lines.push(
      `| \`${rel(candidatePath)}\` | ${run.sourceKind ?? "unknown"} | ${provider} | ${hasCompleteCandidate(run) ? "yes" : "no"} | ${audit} |`,
    );
  }
  lines.push(
    "",
    "## Interpretation",
    "",
    "- `pass` means current files prove the requirement at the artifact level.",
    "- `partial` means tooling or local proof exists but production evidence is weaker than the requirement.",
    "- `missing` means the required evidence is not present in this workspace.",
  );
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const scripts = packageScripts();
  const candidates = candidateRuns();
  const completeCandidates = candidates.filter(({ run }) => hasCompleteCandidate(run));
  const realVideoCandidates = completeCandidates.filter(({ run }) => isRealProviderSource(run));
  const messyComponentCandidates = completeCandidates.filter(({ run }) => run.sourceKind === "image-sheet" && run.reports?.recovery);
  const multiActionResults = walkFiles(path.join(ROOT, "tmp/animation-jobs"), (filePath) => path.basename(filePath) === "results.md");

  const requirements: Requirement[] = [
    scriptRequirement("video/sheet intake, Frame Picker, index, promotion, job, sync commands", scripts, [
      "animation-sheet-intake",
      "frame-picker",
      "animation-index",
      "animation-promote",
      "animation-job",
      "animation-sync-client",
    ]),
    artifactRequirement("animated-spritesheets skill package", [
      "C:/Users/Frankie/.codex/skills/animated-spritesheets/SKILL.md",
      "C:/Users/Frankie/.codex/skills/animated-spritesheets/references/workflow-details.md",
    ]),
    {
      id: "complete local candidate packages with review artifacts",
      status: completeCandidates.length ? "pass" : "missing",
      evidence: completeCandidates.slice(0, 8).map(({ path: candidatePath }) => rel(candidatePath)),
      notes: `${completeCandidates.length} complete candidate package(s) found.`,
    },
    {
      id: "real owner/provider flat-chroma video proof",
      status: realVideoCandidates.length ? "pass" : "missing",
      evidence: realVideoCandidates.map(({ path: candidatePath }) => rel(candidatePath)),
      notes: realVideoCandidates.length
        ? "At least one complete local-video candidate is not from the generated fixture path."
        : "No real owner/provider flat-chroma video candidate is documented in this worktree.",
    },
    {
      id: "component recovery proof for spilled generated sheets",
      status: messyComponentCandidates.length ? "partial" : "missing",
      evidence: messyComponentCandidates.map(({ path: candidatePath }) => rel(candidatePath)),
      notes: messyComponentCandidates.length
        ? "Component recovery is proven on local generated/messy fixtures; a provider-generated spill sheet remains stronger production evidence."
        : "No component-recovery candidate package found.",
    },
    {
      id: "multi-action orchestration proof",
      status: multiActionResults.length ? "partial" : "missing",
      evidence: multiActionResults.map(rel),
      notes: multiActionResults.length
        ? "Job orchestration is proven with local sources; a real walk video plus real attack/cast source remains production evidence."
        : "No job results.md files found.",
    },
    runtimeIndexRequirement(),
  ];

  const outputDir = path.join(ROOT, "tmp/animation-production-audit");
  await mkdir(outputDir, { recursive: true });
  const report = { generatedAt: new Date().toISOString(), requirements, candidateCount: candidates.length };
  await writeFile(path.join(outputDir, "production-readiness.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(path.join(outputDir, "production-readiness.md"), markdown(requirements, candidates), "utf8");
  const summary = {
    pass: requirements.filter((item) => item.status === "pass").length,
    partial: requirements.filter((item) => item.status === "partial").length,
    missing: requirements.filter((item) => item.status === "missing").length,
    report: "tmp/animation-production-audit/production-readiness.md",
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
