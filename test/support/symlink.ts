import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let cached: boolean | undefined;

/**
 * Whether this account may create a symbolic link. Windows grants that only to an
 * elevated shell or with Developer Mode on; without it a symlink-escape case
 * cannot even be set up, so a test that needs one has nothing to assert.
 */
export function canSymlink(): boolean {
  if (cached !== undefined) return cached;
  const dir = mkdtempSync(join(tmpdir(), "orca-symlink-"));
  try {
    writeFileSync(join(dir, "target"), "x");
    symlinkSync(join(dir, "target"), join(dir, "link"));
    cached = true;
  } catch {
    cached = false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return cached;
}
