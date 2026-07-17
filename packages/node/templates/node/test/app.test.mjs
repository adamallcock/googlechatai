import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { chat } from "../src/app.mjs";

test("the sanitized mention fixture reaches the mention handler", async () => {
  const fixture = JSON.parse(
    await fs.readFile(new URL("../fixtures/mention.json", import.meta.url), "utf8"),
  );
  const response = await chat.handlePayload(fixture);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    text: "You said: summarize this",
  });
});
