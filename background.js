const IPAD_MINI_UA = "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

const CLIENT_HINT_HEADERS = [
  "Sec-CH-UA",
  "Sec-CH-UA-Mobile",
  "Sec-CH-UA-Platform",
  "Sec-CH-UA-Platform-Version",
  "Sec-CH-UA-Model",
  "Sec-CH-UA-Full-Version-List",
  "Sec-CH-UA-Arch",
  "Sec-CH-UA-Bitness"
];

function uaRule(id, priority, ua, urlFilter) {
  return {
    id,
    priority,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "User-Agent", operation: "set", value: ua },
        ...CLIENT_HINT_HEADERS.map(header => ({ header, operation: "remove" }))
      ]
    },
    condition: {
      urlFilter,
      resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest", "other"]
    }
  };
}

// 只在降级链路内伪装移动端；任何其他 accounts.google.com 页面保持原生环境，避免污染 Google 风控会话
function buildRules() {
  return [
    uaRule(1, 1, IPAD_MINI_UA, "||accounts.google.com/uplevelingstep/*"),
    uaRule(2, 1, IPAD_MINI_UA, "||accounts.google.com/_/IdvUplevelingUi/*"),
    uaRule(3, 10, IPHONE_UA, "||accounts.google.com/devicephoneverification/*")
  ];
}

const RULE_IDS = [1, 2, 3];

async function applySpoof(enabled) {
  await chrome.storage.local.set({ spoofEnabled: enabled });
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: RULE_IDS,
    addRules: enabled ? buildRules() : []
  });
}

async function restoreSpoofState() {
  const { spoofEnabled: saved } = await chrome.storage.local.get("spoofEnabled");
  await applySpoof(Boolean(saved));
}

chrome.runtime.onInstalled.addListener(restoreSpoofState);
chrome.runtime.onStartup.addListener(restoreSpoofState);
restoreSpoofState();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "downgradeQr") {
    handleDowngrade(msg.qrUrl).then(sendResponse).catch(err => {
      sendResponse({ ok: false, error: String(err) });
    });
    return true;
  }
  if (msg.action === "setSpoof") {
    applySpoof(Boolean(msg.enabled)).then(() => sendResponse({ ok: true })).catch(err => {
      sendResponse({ ok: false, error: String(err) });
    });
    return true;
  }
  if (msg.action === "getState") {
    chrome.storage.local.get("spoofEnabled").then(({ spoofEnabled: saved }) => {
      sendResponse({ ok: true, spoofEnabled: Boolean(saved) });
    });
    return true;
  }
});

async function handleDowngrade(qrUrl) {
  // 模拟手机发起的请求必须带 iPhone UA，先开启伪装再发起
  await applySpoof(true);

  try {
    let targetUrl = qrUrl;
    if (targetUrl.includes("g.co/verify/")) {
      const shortResp = await fetch(targetUrl, { credentials: "include" });
      const shortHtml = await shortResp.text();
      const m = shortHtml.match(/devicephoneverification\/begin\?[^"'\s<>]+/);
      if (m) {
        targetUrl = "https://accounts.google.com/" + m[0]
          .replace(/\\u003d/g, "=")
          .replace(/\\u0026/g, "&")
          .replace(/&quot;.*$/, "");
      }
    }

    const initResp = await fetch(targetUrl, { credentials: "include" });
    const html = await initResp.text();

    const atMatch = html.match(/"SNlM0e":"([^"]+)"/);
    const dshMatch = html.match(/"Qzxixc":"([^"]+)"/);
    let tl = "";
    const ds0Match = html.match(/key:\s*['"]ds:0['"][^\}]*data:\["([^"]+)"\]/);
    if (ds0Match) {
      tl = ds0Match[1];
    } else {
      const tlMatch = html.match(/ADG-[A-Za-z0-9_-]+/);
      if (tlMatch) tl = tlMatch[0];
    }
    if (!atMatch || !dshMatch || !tl) {
      throw new Error("未能从二维码页面提取出 SNlM0e / Qzxixc / TL 参数");
    }
    const at = atMatch[1];
    const dsh = dshMatch[1];

    async function callRpc(rpcid, payload, sourcePath) {
      const url = `https://accounts.google.com/devicephoneverification/_/DevicePhoneVerificationUi/data/batchexecute?rpcids=${rpcid}&source-path=${sourcePath}&hl=en&tl=${encodeURIComponent(tl)}&rt=c`;
      const body = new URLSearchParams({
        "f.req": JSON.stringify([[[rpcid, JSON.stringify(payload), null, "generic"]]]),
        "at": at
      });
      const r = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: body.toString()
      });
      return await r.text();
    }

    await callRpc("MypxBd", [tl, dsh, false, null, null, false, null, null, "browser"], "%2Fdevicephoneverification%2Finitiate");

    const consentUrl = `https://accounts.google.com/devicephoneverification/consent?flow=browser&plt&dsh=${encodeURIComponent(dsh)}&hl=en&tl=${encodeURIComponent(tl)}`;
    const consentResp = await fetch(consentUrl, { credentials: "include" });
    const consentHtml = await consentResp.text();
    const uuidMatch = consentHtml.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    if (!uuidMatch) {
      throw new Error("未能从 consent 页面提取到 UUID");
    }
    const rid = uuidMatch[0];

    const ydResp = await callRpc("YDtwf", [null, rid, dsh, 7, null, tl, false], "%2Fdevicephoneverification%2Fmodacintro");
    return { ok: true, rid, ydResp };
  } catch (err) {
    await applySpoof(false);
    throw err;
  }
}
