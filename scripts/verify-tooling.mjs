import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Read these files as bytes. Never import/evaluate a config to check its safety.
export const protectedFiles = Object.freeze([
  "apps/api/eslint.config.mjs",
  "apps/api/jest.config.js",
  "apps/api/test/jest-e2e.config.js",
  "apps/api/test/jest-integration.config.js",
  "apps/api/prisma.config.ts",
]);

export function integrityFailures(root, manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return ["Invalid tooling integrity manifest."];
  }
  const failures = [];
  for (const relativePath of protectedFiles) {
    const expected = Object.hasOwn(manifest, relativePath)
      ? manifest[relativePath]
      : null;
    if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) {
      failures.push(`${relativePath}: missing or invalid approved digest.`);
      continue;
    }
    try {
      const path = resolve(root, relativePath);
      if (!lstatSync(path).isFile()) {
        failures.push(
          `${relativePath}: expected a regular file, not a symlink.`,
        );
        continue;
      }
      const actual = createHash("sha256")
        .update(readFileSync(path))
        .digest("hex");
      if (actual !== expected) {
        failures.push(`${relativePath}: differs from the reviewed baseline.`);
      }
    } catch {
      failures.push(`${relativePath}: missing or unreadable.`);
    }
  }
  for (const path of Object.keys(manifest)) {
    if (!protectedFiles.includes(path)) {
      failures.push("Manifest contains an unrecognized protected file.");
    }
  }
  return failures;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const root = resolve(dirname(scriptPath), "..");
  try {
    const manifest = JSON.parse(
      readFileSync(resolve(root, "scripts/tooling-integrity.json"), "utf8"),
    );
    const failures = integrityFailures(root, manifest);
    if (failures.length) {
      console.error("Tooling integrity check FAILED:");
      for (const failure of failures) console.error(`- ${failure}`);
      console.error(
        "Do not execute changed configs. Review the complete diff first; see SECURITY.md.",
      );
      process.exitCode = 1;
    } else {
      console.log(
        `Verified ${protectedFiles.length} tooling files without executing them.`,
      );
    }
  } catch {
    console.error(
      "Tooling integrity check FAILED: cannot read the approved manifest.",
    );
    process.exitCode = 1;
  }
}
