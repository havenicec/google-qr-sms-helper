const IPAD_MINI_UA = "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

function setupRules() {
  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1, 2],
    addRules: [
      {
        // 规则 1：覆盖 accounts.google.com 全路径（包括 /uplevelingstep/*、/v3/signin/* 以及提交 6 位验证码的 /_/IdvUplevelingUi/data/batchexecute 接口）
        id: 1,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "User-Agent", operation: "set", value: IPAD_MINI_UA },
            { header: "Sec-CH-UA", operation: "remove" },
            { header: "Sec-CH-UA-Mobile", operation: "remove" },
            { header: "Sec-CH-UA-Platform", operation: "remove" },
            { header: "Sec-CH-UA-Platform-Version", operation: "remove" },
            { header: "Sec-CH-UA-Model", operation: "remove" },
            { header: "Sec-CH-UA-Full-Version-List", operation: "remove" },
            { header: "Sec-CH-UA-Arch", operation: "remove" },
            { header: "Sec-CH-UA-Bitness", operation: "remove" }
          ]
        },
        condition: {
          urlFilter: "||accounts.google.com/*",
          excludedRequestDomains: [],
          resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest", "other"]
        }
      },
      {
        // 规则 2：更高优先级，仅对后台模拟手机扫二维码的 /devicephoneverification/* 使用 iPhone UA
        id: 2,
        priority: 10,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "User-Agent", operation: "set", value: IPHONE_UA },
            { header: "Sec-CH-UA", operation: "remove" },
            { header: "Sec-CH-UA-Mobile", operation: "remove" },
            { header: "Sec-CH-UA-Platform", operation: "remove" },
            { header: "Sec-CH-UA-Platform-Version", operation: "remove" },
            { header: "Sec-CH-UA-Model", operation: "remove" },
            { header: "Sec-CH-UA-Full-Version-List", operation: "remove" }
          ]
        },
        condition: {
          urlFilter: "||accounts.google.com/devicephoneverification/*",
          resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest", "other"]
        }
      }
    ]
  });
}

chrome.runtime.onInstalled.addListener(setupRules);
chrome.runtime.onStartup.addListener(setupRules);
setupRules();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "downgradeQr") {
    handleDowngrade(msg.qrUrl).then(sendResponse).catch(err => {
      sendResponse({ ok: false, error: String(err) });
    });
    return true;
  }
});

async function handleDowngrade(qrUrl) {
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
}
