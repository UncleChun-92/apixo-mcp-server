import assert from "node:assert/strict";
import test from "node:test";
import { browserLaunchSpec } from "../src/browser.js";

const authorizationUrl = "https://apixo.ai/mcp/device-authorization/approve?code=abc123";

test("uses the registered Windows URL handler without cmd.exe", () => {
  assert.deepEqual(browserLaunchSpec(authorizationUrl, "win32", "C:\\Windows"), {
    command: "C:\\Windows\\System32\\rundll32.exe",
    args: ["url.dll,FileProtocolHandler", authorizationUrl],
  });
});

test("uses macOS open", () => {
  assert.deepEqual(browserLaunchSpec(authorizationUrl, "darwin"), {
    command: "open",
    args: [authorizationUrl],
  });
});

test("uses xdg-open on Linux", () => {
  assert.deepEqual(browserLaunchSpec(authorizationUrl, "linux"), {
    command: "xdg-open",
    args: [authorizationUrl],
  });
});

test("rejects non-HTTP URLs", () => {
  assert.equal(browserLaunchSpec("file:///tmp/credential.json", "linux"), null);
});
