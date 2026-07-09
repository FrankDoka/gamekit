import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createReadStream } from "node:fs";

export type PromotionOverwriteDecision = {
  targetExisted: boolean;
  differs: boolean;
  refused: boolean;
  reason?: string;
};

async function fileSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

export async function filesDiffer(left: string, right: string): Promise<boolean> {
  return (await fileSha256(left)) !== (await fileSha256(right));
}

export async function promotionOverwriteDecision(
  sourcePath: string,
  targetPath: string,
  force: boolean,
): Promise<PromotionOverwriteDecision> {
  const targetExisted = existsSync(targetPath);
  if (!targetExisted) return { targetExisted: false, differs: false, refused: false };
  const differs = await filesDiffer(sourcePath, targetPath);
  const refused = differs && !force;
  return {
    targetExisted,
    differs,
    refused,
    reason: refused ? "target exists with different bytes; pass force:true to overwrite" : undefined,
  };
}
