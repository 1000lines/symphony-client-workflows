import assert from "node:assert/strict";
import test from "node:test";
import { greeting } from "../src/greeting.mjs";

test("greets the supplied name", () => {
  assert.equal(greeting("workflow fixture"), "Hello, workflow fixture!");
  assert.equal(greeting("another fixture"), "Hello, another fixture!");
});
