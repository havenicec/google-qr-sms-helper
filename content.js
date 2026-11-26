(() => {
  // 只在 Cloud Shell 页面或二维码页面挂载面板；进入选择框/验证码输入页后完全不干预，防止误跳转
  const isCloudConsole = location.hostname === "console.cloud.google.com";
  const isQrPage = location.pathname.includes("/challenge/iap/qrcode");
  if (!isCloudConsole && !isQrPage) {
    return;
  }

  const panel = document.createElement("div");
  panel.style.cssText = "position:fixed;bottom:20px;right:20px;z-index:999999;background:#1a73e8;color:#fff;padding:12px 16px;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,0.25);font-family:system-ui,sans-serif;font-size:13px;display:flex;flex-direction:column;gap:8px;min-width:240px;max-width:320px;";

  const title = document.createElement("div");
  title.style.cssText = "font-weight:600;font-size:14px;display:flex;justify-content:space-between;align-items:center;";
  title.textContent = "⚡ Google 验证降级助手 v1.2 · Mac 修复版";
  panel.appendChild(title);

  const statusEl = document.createElement("div");
  statusEl.style.cssText = "font-size:12px;color:#e8f0fe;word-break:break-word;line-height:1.4;";
  panel.appendChild(statusEl);

  const btn = document.createElement("button");
  btn.style.cssText = "background:#fff;color:#1a73e8;border:none;padding:8px 12px;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;";
  panel.appendChild(btn);

  document.body.appendChild(panel);

  if (isCloudConsole) {
    statusEl.textContent = "第一步：点击右上角终端图标 [>_] 唤出 Verify 弹窗，或点下方按钮自动唤起";
    btn.textContent = "1. 自动点击 Cloud Shell 终端图标";
    btn.onclick = () => {
      const shellBtn = document.querySelector('button[aria-label*="Cloud Shell"], button[mattooltip*="Cloud Shell"], [id*="cloudshell"]');
      if (shellBtn) {
        shellBtn.click();
        statusEl.textContent = "✅ 已点击终端图标，等待底部弹出 Verify 按钮...";
        setTimeout(() => {
          const allBtns = Array.from(document.querySelectorAll("button, a"));
          const verifyBtn = allBtns.find(b => b.textContent.trim() === "Verify");
          if (verifyBtn) {
            verifyBtn.click();
            statusEl.textContent = "✅ 已自动点击 Verify 按钮！";
          }
        }, 2500);
      } else {
        statusEl.textContent = "⚠️ 未找到终端按钮，请手动点击右上角 [>_] 图标";
      }
    };
  } else if (isQrPage) {
    statusEl.textContent = "已检测到二维码验证页，点击下方按钮一键注入 [3,null,4] 并跳入选择页";
    btn.textContent = "⚡ 一键降级到短信选择框";
    btn.onclick = runDowngrade;
  }

  async function extractQrUrlFromPage() {
    // 所有平台先读页面中的验证链接，避免 macOS 原生解码分支遮蔽可用的兜底。
    const pageUrl = QRCore.findQrUrl(document.body.innerText) ||
      QRCore.findQrUrl(document.documentElement.innerHTML);
    if (pageUrl) return pageUrl;

    let decodeError = "";
    if (typeof window.BarcodeDetector === "function") {
      try {
        const detector = new BarcodeDetector({ formats: ["qr_code"] });
        const mediaEls = Array.from(document.querySelectorAll("img, canvas"));
        for (const el of mediaEls) {
          try {
            if (!el.clientWidth || !el.clientHeight) continue;
            const width = el.naturalWidth || el.width || el.clientWidth;
            const height = el.naturalHeight || el.height || el.clientHeight;
            const c = document.createElement("canvas");
            c.width = width;
            c.height = height;
            const ctx = c.getContext("2d");
            if (!ctx) continue;
            ctx.fillStyle = "#fff";
            ctx.fillRect(0, 0, c.width, c.height);
            ctx.drawImage(el, 0, 0, c.width, c.height);
            const codes = await detector.detect(c);
            for (const code of codes || []) {
              const url = QRCore.normalizeQrUrl(code.rawValue);
              if (url) return url;
            }
          } catch (e) {
            decodeError = (e && e.message) || String(e);
          }
        }
      } catch (e) {
        decodeError = (e && e.message) || String(e);
      }
    }
    // 解码等待期间页面可能刚好完成渲染，再检查一次文本。
    const lateUrl = QRCore.findQrUrl(document.body.innerText) ||
      QRCore.findQrUrl(document.documentElement.innerHTML);
    if (lateUrl) return lateUrl;
    throw new Error("未能在当前页面识别到 Google 验证二维码，请确认二维码图片已加载" +
      (decodeError ? "；原生识别失败：" + decodeError : ""));
  }

  // MV3 的 service worker 随时可能被回收，通道关闭时重试一次
  async function sendToBackground(payload) {
    try {
      return await chrome.runtime.sendMessage(payload);
    } catch (e) {
      await new Promise(r => setTimeout(r, 400));
      return await chrome.runtime.sendMessage(payload);
    }
  }

  async function runDowngrade() {
    try {
      btn.disabled = true;
      btn.textContent = "正在识别二维码...";
      let qrUrl = await extractQrUrlFromPage();

      // g.co 短链是跨域的，只能由后台展开；展开后就是 accounts.google.com 同源地址
      if (!qrUrl.startsWith("https://accounts.google.com/")) {
        statusEl.textContent = "… 展开 g.co 短链";
        const resolved = await sendToBackground({ action: "resolveQrUrl", url: qrUrl });
        if (!resolved || !resolved.ok) throw new Error((resolved && resolved.error) || "展开短链没有返回");
        qrUrl = QRCore.normalizeQrUrl(resolved.url);
        if (!qrUrl || !qrUrl.startsWith("https://accounts.google.com/")) {
          throw new Error("短链没有跳转到 Google 验证页面");
        }
      }

      statusEl.textContent = "已提取二维码，正在注入 [3,null,4]...";

      let res;
      if (qrUrl.startsWith("https://accounts.google.com/")) {
        // 首选：在页面里直接跑（同源、带 cookie），完全不依赖 service worker 的消息通道
        try {
          res = await QRCore.downgrade(qrUrl, (s) => { statusEl.textContent = "… " + s; });
        } catch (inlineErr) {
          try {
            res = await sendToBackground({ action: "downgradeQr", qrUrl });
            if (!res || !res.ok) throw new Error((res && res.error) || "后台没有返回");
          } catch (bgErr) {
            throw new Error(inlineErr.message + "；后台兜底也失败：" +
              ((bgErr && bgErr.message) || String(bgErr)));
          }
        }
      } else {
        res = await sendToBackground({ action: "downgradeQr", qrUrl });
      }

      if (!res || !res.ok) {
        throw new Error((res && res.error) || "没有任何返回");
      }
      if (!res.ydResp.includes("[3,null,4]")) {
        statusEl.textContent = "⚠️ 服务端没给降级状态，返回: " + String(res.ydResp).slice(0, 120);
        btn.disabled = false;
        btn.textContent = "重试一键降级";
        return;
      }

      statusEl.textContent = "✅ [3,null,4] 注入成功！正在跳转短信验证页...";
      const params = new URLSearchParams(location.search);
      let cont = params.get("continue") || "";
      let targetUrl = "";

      if (cont && cont.startsWith("https://accounts.google.com/uplevelingstep/")) {
        cont = cont.replace(/&idv_xdevice=[^&]*/g, "");
        cont = cont.replace(/([?&])authuser(&|$)/, "$1authuser=0$2");
        targetUrl = cont + "&idv_xdevice=1";
      } else {
        targetUrl = location.href.replace("/challenge/iap/qrcode", "/challenge/iap");
        targetUrl = targetUrl.replace(/&idv_xdevice=[^&]*/g, "") + "&idv_xdevice=1";
      }
      await new Promise(r => setTimeout(r, 600));
      location.replace(targetUrl);
    } catch (e) {
      statusEl.textContent = "❌ " + ((e && e.message) || String(e));
      btn.disabled = false;
      btn.textContent = "重试一键降级";
    }
  }
})();
