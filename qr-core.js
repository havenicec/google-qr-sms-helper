/*
 * qr-core.js — 降级流程的核心实现，供 content script 与 service worker 共用
 * （content script 通过 manifest 的 js 数组加载，service worker 通过 importScripts 加载）
 *
 * 注意：这里只处理 accounts.google.com 上的同源请求。
 *   g.co/verify/* 短链是跨域的，必须先由后台展开成 devicephoneverification/begin 地址，再交回这里。
 */
(function (root) {
  const ACCOUNTS = "https://accounts.google.com/";

  function decodeUrlText(text) {
    return String(text || "")
      .replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\\//g, "/")
      .replace(/&amp;|&#(?:0*38|x0*26);/gi, "&");
  }

  function normalizeQrUrl(value) {
    let text = decodeUrlText(value).trim();
    if (/^g\.co\//.test(text)) text = "https://" + text;
    if (/^\/?devicephoneverification\//.test(text)) {
      text = ACCOUNTS + text.replace(/^\//, "");
    }
    try {
      const url = new URL(text);
      if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
      const isShort = url.hostname === "g.co" && /^\/verify\/[A-Za-z0-9_-]+\/?$/.test(url.pathname);
      const isVerification = url.hostname === "accounts.google.com" &&
        /^\/devicephoneverification\/(begin|initiate)$/.test(url.pathname) && url.search;
      return isShort || isVerification ? url.href : null;
    } catch (e) {
      return null;
    }
  }

  function findQrUrl(text) {
    const candidates = decodeUrlText(text).match(
      /https:\/\/accounts\.google\.com\/devicephoneverification\/(?:begin|initiate)\?[^"'\s<>\\]+|(?:https:\/\/)?g\.co\/verify\/[A-Za-z0-9_-]+(?:\?[^"'\s<>\\]+)?|\/?devicephoneverification\/(?:begin|initiate)\?[^"'\s<>\\]+/g
    ) || [];
    for (const candidate of candidates) {
      const url = normalizeQrUrl(candidate);
      if (url) return url;
    }
    return null;
  }

  // 超时覆盖读取响应正文，避免面板永久停在某个阶段；错误里不暴露验证链接的参数。
  async function fetchText(url, options, label) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) throw new Error("HTTP " + response.status);
      return { text: await response.text(), url: response.url };
    } catch (e) {
      const reason = controller.signal.aborted ? "请求超时（20 秒）" : ((e && e.message) || String(e));
      throw new Error(label + "：" + reason);
    } finally {
      clearTimeout(timer);
    }
  }

  // 从验证页 HTML 里抠出 batchexecute 需要的三个参数；缺失时把缺了哪些一并报出来
  function extractTokens(html) {
    const at = html.match(/"SNlM0e":"([^"]+)"/);
    const dsh = html.match(/"Qzxixc":"([^"]+)"/);

    let tl = "";
    const ds0 = html.match(/key:\s*['"]ds:0['"][^\}]*data:\["([^"]+)"\]/);
    if (ds0) {
      tl = ds0[1];
    } else {
      const adg = html.match(/ADG-[A-Za-z0-9_-]+/);
      if (adg) tl = adg[0];
    }

    const missing = [];
    if (!at) missing.push("SNlM0e");
    if (!dsh) missing.push("Qzxixc");
    if (!tl) missing.push("TL");

    return { at: at && at[1], dsh: dsh && dsh[1], tl, missing };
  }

  async function downgrade(qrUrl, onStage) {
    const stage = (s) => {
      try {
        if (onStage) onStage(s);
      } catch (e) {}
    };

    stage("读取验证页");
    const { text: html } = await fetchText(qrUrl, { credentials: "include" }, "读取验证页");

    stage("解析 SNlM0e / Qzxixc / TL");
    const t = extractTokens(html);
    if (t.missing.length) {
      throw new Error(
        "验证页缺少 " + t.missing.join(" / ") + "（页面长度 " + html.length + "）" +
        "；常见原因：页面还没加载完就点了，或 Google 换了字段名"
      );
    }

    const callRpc = async (rpcid, payload, sourcePath) => {
      const url = ACCOUNTS +
        "devicephoneverification/_/DevicePhoneVerificationUi/data/batchexecute" +
        "?rpcids=" + rpcid +
        "&source-path=" + sourcePath +
        "&hl=en&tl=" + encodeURIComponent(t.tl) +
        "&rt=c";
      const body = new URLSearchParams({
        "f.req": JSON.stringify([[[rpcid, JSON.stringify(payload), null, "generic"]]]),
        "at": t.at
      });
      const { text } = await fetchText(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: body.toString()
      }, "RPC " + rpcid);
      return text;
    };

    // SelectNextVerificationMethod -> consent
    stage("RPC MypxBd");
    await callRpc(
      "MypxBd",
      [t.tl, t.dsh, false, null, null, false, null, null, "browser"],
      "%2Fdevicephoneverification%2Finitiate"
    );

    stage("取 consent 里的 UUID");
    const consentUrl = ACCOUNTS +
      "devicephoneverification/consent?flow=browser&plt&dsh=" +
      encodeURIComponent(t.dsh) + "&hl=en&tl=" + encodeURIComponent(t.tl);
    const { text: consentHtml } = await fetchText(consentUrl, { credentials: "include" }, "读取 consent 页面");
    const uuid = consentHtml.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    if (!uuid) {
      throw new Error("consent 页面里没有 UUID（页面长度 " + consentHtml.length + "）");
    }

    // [3, null, 4] = 非 Android 设备回退到短信/语音
    stage("RPC YDtwf");
    const ydResp = await callRpc(
      "YDtwf",
      [null, uuid[0], t.dsh, 7, null, t.tl, false],
      "%2Fdevicephoneverification%2Fmodacintro"
    );

    return { ok: true, rid: uuid[0], ydResp };
  }

  root.QRCore = { extractTokens, downgrade, normalizeQrUrl, findQrUrl, fetchText };
})(typeof self !== "undefined" ? self : globalThis);
