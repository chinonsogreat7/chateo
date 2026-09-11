import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { integrityFailures, protectedFiles } from "./verify-tooling.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "chateo-tooling-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = 'throw new Error("This fixture must never execute");\n';
  const digest = createHash("sha256").update(source).digest("hex");
  const manifest = {};
  for (const path of protectedFiles) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
    manifest[path] = digest;
  }
  return { root, manifest };
}

test("accepts reviewed bytes without importing or executing configs", (t) => {
  const { root, manifest } = fixture(t);
  assert.deepEqual(integrityFailures(root, manifest), []);
});

test("rejects appended bytes, even when hidden after whitespace", (t) => {
  const { root, manifest } = fixture(t);
  writeFileSync(
    join(root, protectedFiles[0]),
    " ".repeat(1000) + "unreviewed();\n",
    {
      flag: "a",
    },
  );
  assert.match(
    integrityFailures(root, manifest)[0],
    /differs from the reviewed baseline/,
  );
});

test("rejects a changed config with no known malware signature", (t) => {
  const { root, manifest } = fixture(t);
  writeFileSync(join(root, protectedFiles[1]), "export default {};\n");
  assert.equal(integrityFailures(root, manifest).length, 1);
});

test("removing a manifest entry cannot bypass verification", (t) => {
  const { root, manifest } = fixture(t);
  delete manifest[protectedFiles[0]];
  assert.match(
    integrityFailures(root, manifest)[0],
    /missing or invalid approved digest/,
  );
});

test("rejects malformed digests and unexpected manifest entries", (t) => {
  const { root, manifest } = fixture(t);
  manifest[protectedFiles[0]] = "*";
  manifest["unexpected.js"] = "a".repeat(64);
  assert.equal(integrityFailures(root, manifest).length, 2);
});

test("fails closed for missing files", (t) => {
  const { root, manifest } = fixture(t);
  rmSync(join(root, protectedFiles[0]));
  assert.match(integrityFailures(root, manifest)[0], /missing or unreadable/);
});

test("rejects config symlinks", (t) => {
  const { root, manifest } = fixture(t);
  const target = join(root, protectedFiles[0]);
  rmSync(target);
  symlinkSync(join(root, protectedFiles[1]), target);
  assert.match(integrityFailures(root, manifest)[0], /expected a regular file/);
});

test("fails closed for malformed manifests", (t) => {
  const { root } = fixture(t);
  for (const manifest of [null, [], false, "invalid"]) {
    assert.deepEqual(integrityFailures(root, manifest), [
      "Invalid tooling integrity manifest.",
    ]);
  }
});
