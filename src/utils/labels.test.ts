import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeLabel } from "./labels.js";

test("sanitizes branch and task labels to bounded lowercase names", () => {
  assert.equal(
    sanitizeLabel("Feature/HELLO_world; $(whoami).."),
    "feature-hello-world-whoami",
  );
  assert.equal(sanitizeLabel("--nice-name--"), "nice-name");
  assert.equal(sanitizeLabel("🔥 / .."), "task");
  assert.equal(sanitizeLabel(""), "task");
  for (const label of ["X".repeat(100), "a-".repeat(100), "-a/b_"]) {
    assert.match(sanitizeLabel(label), /^[a-z0-9-]{1,40}$/);
  }
});
