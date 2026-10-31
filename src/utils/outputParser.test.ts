import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { parseAgyOutput, formatAgyResponseForMCP } from "./outputParser.js";

const fixture = (name: string) =>
  readFileSync(
    new URL(`../../src/utils/fixtures/${name}`, import.meta.url),
    "utf8",
  );

test("parses v3 init, step_update and final result shapes", () => {
  const stdout = fixture("agy-write-success.ndjson");
  const output = parseAgyOutput(stdout);
  assert.match(output.response, /returns `a \+ b`/);
  assert.equal(output.conversationId, "ae1e3504-5457-4ded-a5b9-b607da8afb1f");
  assert.equal(output.status, "SUCCESS");
  assert.equal(output.rawStdout, stdout);
  const init = stdout.split("\n")[0];
  assert.equal(parseAgyOutput(init).conversationId, output.conversationId);
  assert.equal(
    parseAgyOutput(
      JSON.stringify({ event: "init", init: { conversation_id: "nested-id" } }),
    ).conversationId,
    "nested-id",
  );
});

test("empty response returns the denied-run stderr reason", () => {
  const stdout = fixture("agy-denied.ndjson");
  const stderr = fixture("agy-denied.stderr.txt");
  assert.equal(parseAgyOutput(stdout, stderr).response, stderr.trim());
  assert.match(formatAgyResponseForMCP(stdout, stderr), /auto-denied/);
});

test("parses the actual captured failed tiny run without inventing init", () => {
  const stdout = fixture("agy-pong-failed.ndjson");
  const output = parseAgyOutput(stdout);
  assert.equal(output.status, "ERROR");
  assert.equal(output.conversationId, undefined);
  assert.match(output.response, /invalid model selection/);
});

test("keeps final markdown and ignores partial or malformed event lines", () => {
  const raw =
    'noise\n{"event":"step_update","step_update":{"state":"DONE"}}\n' +
    JSON.stringify({
      event: "result",
      result: {
        conversation_id: "final-id",
        status: "SUCCESS",
        response: "# Final\n\n```ts\nx();\n```",
      },
    }) +
    '\n{"event":';
  const result = parseAgyOutput(raw, "warnings");
  assert.equal(result.response, "# Final\n\n```ts\nx();\n```");
  assert.equal(result.conversationId, "final-id");
});

test("plain text remains compatible and full responses include stderr", () => {
  assert.equal(parseAgyOutput("legacy response\n").response, "legacy response");
  assert.match(
    formatAgyResponseForMCP(
      fixture("agy-write-success.ndjson"),
      "warning",
      "full",
    ),
    /warning[\s\S]*has been fixed/,
  );
  assert.equal(parseAgyOutput("", "failure").response, "failure");
  assert.match(
    parseAgyOutput('{"event":"step_update"}').response,
    /no final response/,
  );
});

test("formatting an already parsed response preserves event-shaped JSON", () => {
  const response = '{"event":"result","result":{"response":"user JSON"}}';
  assert.equal(
    formatAgyResponseForMCP({ response, rawStdout: response }),
    response,
  );
});
