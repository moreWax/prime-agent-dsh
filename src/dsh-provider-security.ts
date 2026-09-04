import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Create an unguessable, owner-only Loader root with exclusive file creation. */
export function createPrivateRootConfig(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "prime-dsh-provider-"));
  const path = join(dir, "cordis.yml");
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, "[]\n", "utf8");
  } finally {
    closeSync(fd);
  }
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
