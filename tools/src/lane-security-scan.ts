/**
 * High-risk lane security scan.
 *
 * Usage:
 *   pnpm lane:security-scan <branch>
 *
 * Scans the branch diff against master for credential-shaped additions,
 * dependency surface changes, outbound network calls, --no-verify, and bypass
 * tokens. Bypass tokens are REVIEW findings because legitimate enforcement work
 * often edits them; blocking findings exit nonzero.
 */
import { execFileSync } from "node:child_process";
import { integrationBranch } from "./toolkit-config.js";

type Finding = {
  severity: "BLOCK" | "REVIEW";
  rule: string;
  file: string;
  detail: string;
};

type AddedLine = {
  file: string;
  line: string;
  packageSection: string | null;
};

const ROOT = process.cwd();

function git(args: string[]): string {
  // 256MB buffer + binary exclusions: art-lane branches carry many MB of PNG/webp
  // deltas that blew the default spawn buffer (ENOBUFS, p3-batch-1 2026-07-07).
  // The scan greps TEXT additions; binaries can't match its line patterns anyway.
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  }).trim();
}

const BINARY_EXCLUDES = [
  ":(exclude)*.png",
  ":(exclude)*.webp",
  ":(exclude)*.jpg",
  ":(exclude)*.gif",
  ":(exclude)*.mp4",
  ":(exclude)*.dump",
];

function usage(): never {
  console.error("usage: pnpm lane:security-scan <branch>");
  process.exit(2);
}

function diffAddedLines(diff: string): AddedLine[] {
  const added: AddedLine[] = [];
  let file = "(unknown)";
  let packageSection: string | null = null;
  for (const line of diff.split(/\r?\n/)) {
    const fileMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (fileMatch) {
      file = fileMatch[2];
      packageSection = null;
      continue;
    }
    const content = line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") ? line.slice(1) : line;
    if (/package\.json$/.test(file)) {
      const section = /^\s*"(scripts|dependencies|devDependencies|peerDependencies|optionalDependencies)"\s*:/.exec(content);
      if (section) packageSection = section[1];
      else if (/^\s*"[A-Za-z0-9_./:-]+"\s*:/.test(content) && !/^\s{4,}"/.test(content)) packageSection = null;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added.push({ file, line: line.slice(1), packageSection });
    }
  }
  return added;
}

function addFinding(findings: Finding[], severity: Finding["severity"], rule: string, file: string, detail: string): void {
  findings.push({ severity, rule, file, detail: detail.trim().slice(0, 180) });
}

function main(): number {
  const branch = process.argv[2];
  if (!branch) usage();

  const mergeBase = git(["merge-base", integrationBranch(), branch]);
  const files = git(["diff", "--name-only", `${mergeBase}..${branch}`]).split(/\r?\n/).filter(Boolean);
  const diff = git(["diff", "--unified=0", `${mergeBase}..${branch}`, "--", ".", ...BINARY_EXCLUDES]);
  const added = diffAddedLines(diff);
  const findings: Finding[] = [];

  if (files.some((file) => /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/.test(file))) {
    addFinding(findings, "BLOCK", "dependencies", "(lockfile)", "branch changes a package lockfile");
  }

  const credentialPatterns = [
    /\b(?:api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*['"][^'"]{12,}['"]/i,
    /\b(?:sk|pk)_[A-Za-z0-9]{20,}\b/,
    /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/,
    /\b[A-Za-z0-9_\/+=-]{32,}\.[A-Za-z0-9_\/+=-]{32,}\.[A-Za-z0-9_\/+=-]{16,}\b/,
  ];
  const networkPatterns = [/\b(?:fetch|axios|WebSocket|EventSource)\s*\(/, /\bhttps?:\/\//i];
  const bypassPattern = /GAMEKIT_[A-Z0-9_]+_(?:SKIP|OK|FULL)|GAMEKIT_PRECOMMIT_FULL/;

  for (const { file, line, packageSection } of added) {
    const scannerSelfPatternLine =
      file === "tools/src/lane-security-scan.ts" &&
      /credentialPatterns|networkPatterns|bypassPattern|--no-verify|outbound-network|credential-shaped-string/.test(line);
    const scannerReportLine = file.endsWith(".md") && line.trimStart().startsWith("[lane:security-scan]");
    if (scannerReportLine) continue;
    if (credentialPatterns.some((pattern) => pattern.test(line)) && !scannerSelfPatternLine) {
      addFinding(findings, "BLOCK", "credential-shaped-string", file, line);
    }
    // Loopback traffic is not outbound network (the rule's intent). Two exemptions:
    // (a) lines whose only URL is 127.0.0.1/localhost; (b) smoke/capture harness files,
    // which boot their own loopback servers and fetch them via variables the line-level
    // regex cannot resolve. Credential/bypass/no-verify rules still apply everywhere.
    const loopbackOnlyLine = /127\.0\.0\.1|\blocalhost\b/.test(line) && !/https?:\/\/(?!127\.0\.0\.1|localhost)[\w.-]/i.test(line);
    const loopbackHarnessFile = /^tools\/src\/(?:[\w-]*smoke[\w-]*|smoke\/[\w-]+|capture-[\w-]+)\.ts$/.test(file);
    // Three adjudicated downgrades (session 18, procgen-port false positives —
    // integrator-verified each class): none of these are outbound network.
    // (a) a bare https:// URL in a markdown doc (attribution/reference links —
    //     THIRD-PARTY.md is REQUIRED to carry upstream URLs) -> REVIEW;
    // (b) a fetch() whose target literal is root-relative ("/api/...") with no
    //     protocol anywhere on the line = same-origin by construction -> REVIEW;
    // (c) the deterministic vitest snapshot header comment in .snap files -> skip.
    // Absolute URLs and network calls in code still BLOCK.
    const vitestSnapHeader = file.endsWith(".snap") && /^\/\/ Vitest Snapshot v\d/.test(line.trim());
    const docUrlOnly = file.endsWith(".md") && !/\b(?:fetch|axios|WebSocket|EventSource)\s*\(/.test(line);
    const sameOriginFetch =
      /\bfetch\s*\(\s*(?:`\/(?!\/)|'\/(?!\/)|"\/(?!\/))/.test(line) && !/https?:\/\//i.test(line) && !/\b(?:axios|WebSocket|EventSource)\s*\(/.test(line);
    if (
      networkPatterns.some((pattern) => pattern.test(line)) &&
      !scannerSelfPatternLine &&
      !loopbackOnlyLine &&
      !loopbackHarnessFile &&
      !vitestSnapHeader
    ) {
      addFinding(findings, docUrlOnly || sameOriginFetch ? "REVIEW" : "BLOCK", "outbound-network", file, line);
    }
    if (/--no-verify\b/.test(line) && !scannerSelfPatternLine) {
      addFinding(findings, "BLOCK", "no-verify", file, line);
    }
    if (bypassPattern.test(line) && !scannerSelfPatternLine) {
      addFinding(findings, "REVIEW", "bypass-token", file, line);
    }
    if (/^\s*"[^"]+":\s*"[^"]+"/.test(line) && /package\.json$/.test(file)) {
      if (packageSection && /^(dependencies|devDependencies|peerDependencies|optionalDependencies)$/.test(packageSection)) {
        addFinding(findings, "BLOCK", "dependencies", file, line);
      }
    }
  }

  const blockCount = findings.filter((finding) => finding.severity === "BLOCK").length;
  console.log(`[lane:security-scan] branch=${branch}`);
  console.log(`[lane:security-scan] base=${mergeBase}`);
  console.log(`[lane:security-scan] files=${files.length} added_lines=${added.length}`);
  if (findings.length === 0) {
    console.log("[lane:security-scan] OK: no dependency, credential, outbound-network, --no-verify, or bypass-token findings.");
  } else {
    for (const finding of findings) {
      console.log(`[lane:security-scan] ${finding.severity} ${finding.rule} ${finding.file}: ${finding.detail}`);
    }
  }
  if (blockCount > 0) {
    console.error(`[lane:security-scan] FAIL: ${blockCount} blocking finding(s).`);
    return 1;
  }
  console.log("[lane:security-scan] OK: no blocking findings.");
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(`[lane:security-scan] ${(error as Error).message}`);
  process.exit(1);
}
