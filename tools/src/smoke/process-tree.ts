import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";

const PROCESS_EXIT_TIMEOUT_MS = 5_000;

export function spawnProcessTree(command: string, args: string[], options: SpawnOptions): ChildProcess {
  return spawn(command, args, {
    ...options,
    detached: process.platform !== "win32",
  });
}

export async function stopProcessTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    await waitForExit(child);
    closeChildPipes(child);
    return;
  }

  signalProcessGroup(child, "SIGTERM");
  if (!(await waitForExit(child, PROCESS_EXIT_TIMEOUT_MS))) {
    signalProcessGroup(child, "SIGKILL");
    await waitForExit(child, PROCESS_EXIT_TIMEOUT_MS);
  }
  closeChildPipes(child);
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

function waitForExit(child: ChildProcess, timeoutMs = PROCESS_EXIT_TIMEOUT_MS): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve(true);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", onExit);
    };
    child.once("exit", onExit);
  });
}

function closeChildPipes(child: ChildProcess): void {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
}
