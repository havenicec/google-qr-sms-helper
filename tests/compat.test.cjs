const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const repo = path.resolve(__dirname, "..");
const source = (name) => fs.readFileSync(path.join(repo, name), "utf8");
const verificationUrl = "https://accounts.google.com/devicephoneverification/begin?token=fixture&flow=browser";

function coreContext(fetch) {
  const context = vm.createContext({ URL, URLSearchParams, fetch, AbortController, setTimeout, clearTimeout });
  vm.runInContext(source("qr-core.js"), context);
  return context;
}

async function clickPanel({ text = "", html = "", detector, media = [], inlineError, backgroundError } = {}) {
  const created = [];
  const messages = [];
  const urls = [];
  const navigations = [];
  const context = coreContext();
  context.document = {
    body: { innerText: text, appendChild() {} },
    documentElement: { innerHTML: html },
    querySelectorAll: () => media,
    createElement(tag) {
      const element = {
        tagName: tag.toUpperCase(), style: {}, textContent: "", disabled: false,
        appendChild() {},
        getContext: () => ({ fillRect() {}, drawImage() {} })
      };
      created.push(element);
      return element;
    }
  };
  context.window = context;
  if (detector) context.BarcodeDetector = detector;
  context.location = {
    hostname: "accounts.google.com", pathname: "/v3/signin/challenge/iap/qrcode",
    search: "?flow=fixture", href: "https://accounts.google.com/v3/signin/challenge/iap/qrcode?flow=fixture",
    replace: (url) => navigations.push(url)
  };
  context.setTimeout = (callback) => { callback(); return 1; };
  context.chrome = { runtime: { sendMessage: async (message) => {
    messages.push(message);
    if (backgroundError) return { ok: false, error: backgroundError };
    if (message.action === "resolveQrUrl") return { ok: true, url: verificationUrl };
    return { ok: true, ydResp: "[3,null,4]" };
  } } };
  context.QRCore.downgrade = async (url) => {
    urls.push(url);
    if (inlineError) throw new Error(inlineError);
    return { ok: true, ydResp: "[3,null,4]" };
  };
  vm.runInContext(source("content.js"), context);
  await created.find((element) => element.tagName === "BUTTON").onclick();
  return { urls, messages, navigations, status: created[2].textContent };
}

async function resolveShort(response) {
  let listener;
  const context = coreContext(async () => response);
  context.importScripts = () => {};
  context.console = console;
  context.chrome = {
    declarativeNetRequest: { updateDynamicRules: async () => {} },
    runtime: {
      onInstalled: { addListener() {} }, onStartup: { addListener() {} },
      onMessage: { addListener(value) { listener = value; } }
    }
  };
  vm.runInContext(source("background.js"), context);
  return await new Promise((resolve) => listener({ action: "resolveQrUrl", url: "https://g.co/verify/fixture" }, {}, resolve));
}

test("the page text path continues to work without BarcodeDetector", async () => {
  const result = await clickPanel({ text: "g.co/verify/fixture" });
  assert.deepEqual(result.urls, [verificationUrl]);
  assert.equal(result.navigations.length, 1);
});

test("a native detector initialization error does not suppress the HTML fallback", async () => {
  const result = await clickPanel({
    html: `<a href="${verificationUrl}">Verify</a>`,
    detector: class { constructor() { throw new Error("qr_code unsupported"); } }
  });
  assert.deepEqual(result.urls, [verificationUrl]);
  assert.equal(result.navigations.length, 1);
});

test("native decoding skips unrelated codes and accepts a later verification code", async () => {
  const result = await clickPanel({
    media: [{ clientWidth: 256, clientHeight: 256, naturalWidth: 256, naturalHeight: 256 }],
    detector: class { async detect() { return [{ rawValue: "https://example.com/qr" }, { rawValue: verificationUrl }]; } }
  });
  assert.deepEqual(result.urls, [verificationUrl]);
  assert.equal(result.messages.length, 0);
});

test("a visible QR scaled below 80 CSS pixels can still be decoded", async () => {
  const result = await clickPanel({
    media: [{ clientWidth: 64, clientHeight: 64, naturalWidth: 256, naturalHeight: 256 }],
    detector: class { async detect() { return [{ rawValue: verificationUrl }]; } }
  });
  assert.deepEqual(result.urls, [verificationUrl]);
});

test("native decoding does not send unrelated QR URLs to the worker", async () => {
  const result = await clickPanel({
    media: [{ clientWidth: 256, clientHeight: 256, naturalWidth: 256, naturalHeight: 256 }],
    detector: class { async detect() { return [{ rawValue: "https://example.com/qr" }]; } }
  });
  assert.equal(result.messages.length, 0);
  assert.equal(result.navigations.length, 0);
  assert.match(result.status, /未能.*二维码/);
});

test("HTML entities in verification links are decoded before fetching", async () => {
  const result = await clickPanel({ html: `<a href="${verificationUrl.replaceAll("&", "&amp;")}">Verify</a>` });
  assert.deepEqual(result.urls, [verificationUrl]);
});

test("the worker uses a short link's final redirect URL even without a begin link in the body", async () => {
  const result = await resolveShort({ ok: true, status: 200, url: verificationUrl, text: async () => "<html>verification page</html>" });
  assert.equal(result.ok, true);
  assert.equal(result.url, verificationUrl);
});

test("the worker preserves HTTP failures instead of reporting a missing link", async () => {
  const result = await resolveShort({ ok: false, status: 503, url: "https://g.co/verify/fixture", text: async () => "unavailable" });
  assert.equal(result.ok, false);
  assert.match(result.error, /HTTP 503/);
});

test("verification HTTP failures do not masquerade as missing tokens", async () => {
  const context = coreContext(async () => ({ ok: false, status: 403, url: verificationUrl, text: async () => "forbidden" }));
  await assert.rejects(context.QRCore.downgrade(verificationUrl), /读取验证页.*HTTP 403/);
});

test("an inline failure remains visible when the background fallback returns an error", async () => {
  const result = await clickPanel({ html: verificationUrl, inlineError: "读取验证页 HTTP 403", backgroundError: "worker failed" });
  assert.match(result.status, /读取验证页 HTTP 403/);
  assert.match(result.status, /worker failed/);
  assert.equal(result.navigations.length, 0);
});

test("escaped script URLs are decoded without dropping their query parameters", async () => {
  const encoded = verificationUrl.replaceAll("/", "\\/").replaceAll("=", "\\u003d").replaceAll("&", "\\u0026");
  const result = await clickPanel({ html: `{"verificationUrl":"${encoded}"}` });
  assert.deepEqual(result.urls, [verificationUrl]);
});

test("a short link with a relative begin link still resolves without an HTTP redirect", async () => {
  const relative = verificationUrl.replace("https://accounts.google.com/", "").replaceAll("&", "&amp;");
  const result = await resolveShort({ ok: true, status: 200, url: "https://g.co/verify/fixture", text: async () => `<a href="${relative}">Verify</a>` });
  assert.equal(result.ok, true);
  assert.equal(result.url, verificationUrl);
});

test("a stalled response body times out and clears the request timer", async () => {
  let timeout;
  let cleared = false;
  let signal;
  let bodyStarted;
  const ready = new Promise((resolve) => { bodyStarted = resolve; });
  const context = coreContext(async (url, options) => {
    signal = options.signal;
    return {
      ok: true, url,
      text: () => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
        bodyStarted();
      })
    };
  });
  context.setTimeout = (callback) => { timeout = callback; return 123; };
  context.clearTimeout = (timer) => { cleared = timer === 123; };
  const pending = context.QRCore.fetchText(verificationUrl, {}, "读取验证页");
  await ready;
  timeout();
  await assert.rejects(pending, /读取验证页.*请求超时/);
  assert.equal(signal.aborted, true);
  assert.equal(cleared, true);
});

test("the shared core still completes the verification request sequence", async () => {
  const requests = [];
  const pages = [
    '"SNlM0e":"fixture-at","Qzxixc":"fixture-dsh"; ADG-fixture-tl',
    "[]",
    "00000000-0000-4000-8000-000000000000",
    "[3,null,4]"
  ];
  const context = coreContext(async (url, options) => {
    requests.push({ url, options });
    const text = pages[requests.length - 1];
    assert.notEqual(text, undefined);
    return { ok: true, status: 200, url, text: async () => text };
  });
  const result = await context.QRCore.downgrade(verificationUrl);
  assert.equal(result.ok, true);
  assert.equal(result.ydResp, "[3,null,4]");
  assert.equal(requests.length, 4);
  assert.equal(requests[1].options.method, "POST");
  assert.equal(requests[3].options.method, "POST");
  assert.equal(new URL(requests[3].url).searchParams.get("rpcids"), "YDtwf");
});
