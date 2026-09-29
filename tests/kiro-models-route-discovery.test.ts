import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import { clearModelCache, markModelsFetchFailure, markProviderDiscoveryFailed, markProviderDiscoveryOk, setCached } from "../src/codex/model-cache";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

let home: string;
let previousHome: string | undefined;
let isolated: IsolatedCodexHome;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "kiro-route-"));
  process.env.OPENCODEX_HOME = home;
  isolated = installIsolatedCodexHome("kiro-route-");
  clearModelCache();
});

afterEach(() => {
  clearModelCache();
  isolated.restore();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

async function listModels(path = "/v1/models", authenticated = true) {
  saveConfig({
    port: 0, defaultProvider: "kiro", openaiProviderTierVersion: 2,
    providers: {
      kiro: { adapter: "kiro", baseUrl: "https://runtime.us-east-1.kiro.dev", apiKey: authenticated ? "fixture" : undefined, liveModels: false, models: ["claude-opus-5"] },
      static: { adapter: "openai-chat", baseUrl: "https://example.com", liveModels: false, models: ["static-model"] },
    },
  });
  const server = startServer(0);
  try {
    const response = await fetch(new URL(path, server.url));
    expect(response.status).toBe(200);
    return await response.json();
  } finally {
    server.stop(true);
  }
}

test("OpenAI list exposes only known configured-provider discovery statuses", async () => {
  setCached("kiro", [{ provider: "kiro", id: "claude-opus-5.5" }]);
  markProviderDiscoveryOk("kiro", 1);
  markProviderDiscoveryOk("removed", 1);
  const body = await listModels();
  expect(body.object).toBe("list");
  expect(body.data).toContainEqual({ id: "kiro/claude-opus-5.5", object: "model", created: 0, owned_by: "kiro" });
  expect(body.discovery).toEqual({ kiro: { status: "ok" } });
});

test.each([false, true])("failed discovery stays failed with cached catalog: %s", async cached => {
  if (cached) setCached("kiro", [{ provider: "kiro", id: "claude-opus-5.5" }]);
  markModelsFetchFailure("kiro");
  markProviderDiscoveryFailed("kiro", { reason: "http", httpStatus: 503 });
  const body = await listModels();
  expect(body.data.some((model: { id: string }) => model.id === `kiro/${cached ? "claude-opus-5.5" : "claude-opus-5"}`)).toBe(true);
  expect(body.discovery).toEqual({ kiro: { status: "failed", reason: "http", httpStatus: 503 } });
});

test("missing credentials replaces previously successful discovery in the route", async () => {
  markProviderDiscoveryOk("kiro", 1);
  expect((await listModels("/v1/models", false)).discovery).toEqual({ kiro: { status: "failed", reason: "provider" } });
});

test("an unverified cached list does not invent a successful discovery status", async () => {
  setCached("kiro", [{ provider: "kiro", id: "claude-opus-5.5" }]);
  expect((await listModels()).discovery).toBeUndefined();
});

test.each(["/v1/models?client_version=1", "/v1/models?flavor=anthropic"])("does not change the discovery contract for %s", async path => {
  setCached("kiro", [{ provider: "kiro", id: "claude-opus-5.5" }]);
  markProviderDiscoveryOk("kiro", 1);
  expect((await listModels(path)).discovery).toBeUndefined();
});
