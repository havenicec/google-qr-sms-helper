importScripts("qr-core.js");

const IPAD_MINI_UA = "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

function setupRules() {
  return chrome.declarativeNetRequest.updateDynamicRules({
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
  }).catch((e) => {
    // UA 伪装修正是整个流程的前提，失败必须打出来，不能像以前那样静默
    console.error("[qr-helper] 注入请求头规则失败，UA 伪装可能不生效：", e);
  });
}

chrome.runtime.onInstalled.addListener(() => setupRules());
chrome.runtime.onStartup.addListener(() => setupRules());
setupRules();

let STAGE = "init";
let busy = false;

// 把 g.co/verify/* 短链展开成 devicephoneverification/begin 地址（跨域，只能在这里做）
async function resolveQrUrl(url) {
  const shortUrl = QRCore.normalizeQrUrl(url);
  if (!shortUrl || new URL(shortUrl).hostname !== "g.co") throw new Error("不是有效的 g.co 验证短链");
  const response = await QRCore.fetchText(shortUrl, { credentials: "include" }, "展开 g.co 短链");
  // fetch 会自动跟随重定向，最终页面不一定还包含 begin 链接。
  const finalUrl = QRCore.normalizeQrUrl(response.url);
  if (finalUrl && finalUrl.startsWith("https://accounts.google.com/")) return finalUrl;
  const pageUrl = QRCore.findQrUrl(response.text);
  if (pageUrl && pageUrl.startsWith("https://accounts.google.com/")) return pageUrl;
  throw new Error("g.co 短链没有返回 Google 验证地址，请刷新二维码后重试");
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.action === "resolveQrUrl") {
    resolveQrUrl(msg.url)
      .then((url) => sendResponse({ ok: true, url }))
      .catch((e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
    return true;
  }

  if (msg.action === "downgradeQr") {
    if (busy) {
      sendResponse({ ok: false, error: "上一次降级请求还在进行中，请稍等几秒再点", stage: STAGE });
      return;
    }
    busy = true;
    (async () => {
      try {
        let url = msg.qrUrl;
        if (!url.startsWith("https://accounts.google.com/")) {
          url = await resolveQrUrl(url);
        }
        sendResponse(await QRCore.downgrade(url, (s) => { STAGE = s; }));
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) || String(e), stage: STAGE });
      } finally {
        busy = false;
      }
    })();
    return true;
  }
});
