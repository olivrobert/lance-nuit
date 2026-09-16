import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
export function findSessionFile(sessionId: string): string | null {
  const root = join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return null;
  const filename = `${sessionId}.jsonl`;
  for (const sub of readdirSync(root)) {
    const candidate = join(root, sub, filename);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
export function sessionFileSizeKb(sessionId: string): number {
  const path = findSessionFile(sessionId);
  if (!path) return 0;
  try {
    return Math.round(statSync(path).size / 1024);
  } catch {
    return 0;
  }
}
