import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchProviderModels } from "../src/codex/catalog/provider-fetch";
import { clearModelCache, getProviderDiscoveryStatus } from "../src/codex/model-cache";
import { normalizeKiroModelId } from "../src/providers/kiro-models";
import { buildKiroPayload } from "../src/adapters/kiro";
import { routeModel } from "../src/router";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

const previousHome = process.env.OPENCODEX_HOME;
let home: string;
let requests: URL[];
let respond: (url: URL) => Response;
let provider: OcxProviderConfig;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kiro-catalog-"));
  process.env.OPENCODEX_HOME = home;
  clearModelCache();
  requests = [];
  respond = () => Response.json({ models: [{ modelId: "claude-opus-5.5" }] });
  provider = {
    adapter: "kiro", baseUrl: "https://runtime.us-east-1.kiro.dev",
    apiKey: "test-token", liveModels: false, models: ["claude-opus-5"],
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push(url);
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
      return respond(url);
    }) as typeof fetch,
  };
});

afterEach(() => {
  clearModelCache();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

test("discovers Opus 5.5 despite the static generic-discovery flag and caches it", async () => {
  const models = await fetchProviderModels("kiro", provider, 60_000);
  expect(models.map(model => [model.provider, model.id])).toEqual([["kiro", "claude-opus-5.5"]]);
  expect(getProviderDiscoveryStatus("kiro")).toEqual({ status: "ok" });
  expect(requests[0].origin).toBe("https://q.us-east-1.amazonaws.com");
  expect(requests[0].pathname).toBe("/ListAvailableModels");
  expect(requests[0].searchParams.get("origin")).toBe("AI_EDITOR");
  expect(requests[0].searchParams.has("profileArn")).toBe(false);
  await fetchProviderModels("kiro", provider, 60_000);
  expect(requests).toHaveLength(1);
  expect(normalizeKiroModelId("kiro/claude-opus-5.5")).toBe("claude-opus-5.5");
});

test("uses the same OAuth snapshot for token, region and optional profile across pages", async () => {
  const profileArn = "arn:aws:codewhisperer:eu-central-1:000000000000:profile/test";
  writeFileSync(join(home, "auth.json"), JSON.stringify({ kiro: {
    activeAccountId: "test", accounts: [{ id: "test", credential: {
      access: "test-token", refresh: "unused", expires: Date.now() + 3_600_000,
      kiro: { profileArn, apiRegion: "eu-central-1" },
    } }],
  } }));
  provider.authMode = "oauth";
  respond = url => Response.json(url.searchParams.has("nextToken")
    ? { models: [{ modelId: "claude-opus-5.5" }, { modelId: "claude-opus-5" }] }
    : { models: [{ modelId: "claude-opus-5" }], nextToken: "page two/+=" });
  const models = await fetchProviderModels("kiro", provider, 0);
  expect(models.map(model => model.id)).toEqual(["claude-opus-5", "claude-opus-5.5"]);
  expect(requests).toHaveLength(2);
  for (const url of requests) {
    expect(url.origin).toBe("https://q.eu-central-1.amazonaws.com");
    expect(url.searchParams.get("profileArn")).toBe(profileArn);
  }
  expect(requests[1].searchParams.get("nextToken")).toBe("page two/+=");
});

test.each([
  ["http", () => new Response(null, { status: 401 })],
  ["redirect", () => new Response(null, { status: 302, headers: { location: "https://example.com" } })],
  ["json", () => new Response("not json")],
  ["wrong provider shape", () => Response.json({ data: [{ id: "other/claude-opus-5.5" }] })],
  ["namespaced id", () => Response.json({ models: [{ modelId: "other/claude-opus-5.5" }] })],
  ["empty", () => Response.json({ models: [] })],
  ["network", () => { throw new TypeError("offline"); }],
  ["timeout", () => { throw new DOMException("timed out", "TimeoutError"); }],
  ["repeated cursor", () => Response.json({ models: [{ modelId: "claude-opus-5.5" }], nextToken: "same" })],
] as const)("preserves static fallback on %s", async (_label, response) => {
  respond = response;
  const models = await fetchProviderModels("kiro", provider, 0);
  expect(models.map(model => model.id)).toEqual(["claude-opus-5"]);
  expect(getProviderDiscoveryStatus("kiro")?.status).toBe("failed");
  expect(requests.every(url => url.pathname === "/ListAvailableModels")).toBe(true);
  const requestCount = requests.length;
  await fetchProviderModels("kiro", provider, 0);
  expect(requests).toHaveLength(requestCount);
  expect(getProviderDiscoveryStatus("kiro")?.status).toBe("failed");
});

test("discards partial pages and keeps the last successful catalog on failure", async () => {
  await fetchProviderModels("kiro", provider, 0);
  respond = url => url.searchParams.has("nextToken") ? new Response(null, { status: 503 })
    : Response.json({ models: [{ modelId: "partial" }], nextToken: "next" });
  const models = await fetchProviderModels("kiro", provider, 0);
  expect(models.map(model => model.id)).toEqual(["claude-opus-5.5"]);
  expect(getProviderDiscoveryStatus("kiro")).toEqual({ status: "failed", reason: "http", httpStatus: 503 });
  await fetchProviderModels("kiro", provider, 60_000);
  expect(getProviderDiscoveryStatus("kiro")?.status).toBe("failed");
});

test.each(["key", "oauth"] as const)("missing %s credentials replaces prior success without generation", async authMode => {
  await fetchProviderModels("kiro", provider, 0);
  provider.authMode = authMode;
  delete provider.apiKey;
  expect((await fetchProviderModels("kiro", provider, 60_000)).map(model => model.id)).toEqual(["claude-opus-5"]);
  expect(getProviderDiscoveryStatus("kiro")).toEqual({ status: "failed", reason: "provider" });
  expect(requests).toHaveLength(1);
});

test("does not query without credentials or override another adapter's static flag", async () => {
  delete provider.apiKey;
  await fetchProviderModels("kiro", provider, 0);
  provider.adapter = "openai-chat";
  provider.apiKey = "test-token";
  await fetchProviderModels("other", provider, 0);
  expect(requests).toHaveLength(0);
});

test("routes a newly discovered namespaced ID unchanged into the Kiro wire payload", () => {
  const route = routeModel({ providers: { kiro: provider } }, "kiro/claude-opus-5.5");
  expect(route.modelId).toBe("claude-opus-5.5");
  const parsed = {
    modelId: route.modelId, stream: true, options: {},
    context: { messages: [{ role: "user", content: "fixture only" }] },
  } as OcxParsedRequest;
  const built = buildKiroPayload(parsed, undefined);
  expect(built.payload).toMatchObject({ conversationState: {
    currentMessage: { userInputMessage: { modelId: "claude-opus-5.5" } },
  } });
});
