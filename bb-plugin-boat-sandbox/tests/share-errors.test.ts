import { test } from "node:test";
import assert from "node:assert/strict";
import { shareErrorMessage } from "../share-errors.js";

test("share explains missing apps and machines without exposing raw error details", () => {
  assert.match(shareErrorMessage(new Error("App is not ready. Start it first")), /development command and port/);
  assert.match(shareErrorMessage(new Error("This thread is not on a Boat machine.")), /does not use a Boat sandbox/);
  assert.match(shareErrorMessage(new Error("Resume the thread's Boat machine before opening its preview.")), /Resume it/);
  assert.doesNotMatch(shareErrorMessage(new Error("https://app.on.boat.dev/?_token=secret")), /secret|_token/);
});
