(() => {
  // 只在 Cloud Shell 页面或二维码页面挂载面板，进入选择框/验证码输入页后完全不干预页面，防止任何误跳转
  const isCloudConsole = location.hostname === "console.cloud.google.com";
  const isQrPage = location.pathname.includes("/challenge/iap/qrcode");
  if (!isCloudConsole && !isQrPage) {
    return;
  }

  const panel = document.createElement("div");
  panel.style.cssText = "position:fixed;bottom:20px;right:20px;z-index:999999;background:#1a73e8;color:#fff;padding:12px 16px;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,0.25);font-family:system-ui,sans-serif;font-size:13px;display:flex;flex-direction:column;gap:8px;min-width:240px;max-width:320px;";
  
  const title = document.createElement("div");
  title.style.cssText = "font-weight:600;font-size:14px;display:flex;justify-content:space-between;align-items:center;";
  title.textContent = "⚡ Google 验证降级助手 v1.1";
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
    if ("BarcodeDetector" in window) {
      const detector = new BarcodeDetector({ formats: ["qr_code"] });
      const mediaEls = Array.from(document.querySelectorAll("img, canvas"));
      for (const el of mediaEls) {
        try {
          if (el.clientWidth > 80 && el.clientHeight > 80) {
            const c = document.createElement("canvas");
            c.width = el.naturalWidth || el.clientWidth || 300;
            c.height = el.naturalHeight || el.clientHeight || 300;
            const ctx = c.getContext("2d");
            ctx.fillStyle = "#fff";
            ctx.fillRect(0, 0, c.width, c.height);
            ctx.drawImage(el, 0, 0, c.width, c.height);
            const codes = await detector.detect(c);
            if (codes && codes.length > 0 && codes[0].rawValue) {
              return codes[0].rawValue;
            }
          }
        } catch (e) {}
      }
    }
    const bodyText = document.body.innerText || "";
    const shortMatch = bodyText.match(/g\.co\/verify\/[A-Za-z0-9_-]+/);
    if (shortMatch) {
      return "https://" + shortMatch[0];
    }
    const html = document.documentElement.innerHTML;
    const m = html.match(/https:\/\/accounts\.google\.com\/devicephoneverification\/begin\?[^"'\s<>]+/);
    if (m) return m[0].replace(/\\u003d/g, "=").replace(/\\u0026/g, "&");
    throw new Error("未能在当前页面识别到二维码，请确认二维码图片已加载");
  }

  async function runDowngrade() {
    try {
      btn.disabled = true;
      btn.textContent = "正在识别二维码...";
      const qrUrl = await extractQrUrlFromPage();
      statusEl.textContent = "已提取二维码，正在后台注入 [3,null,4]...";

      const res = await chrome.runtime.sendMessage({ action: "downgradeQr", qrUrl });
      if (!res || !res.ok) {
        throw new Error(res ? res.error : "后台请求失败");
      }
      if (!res.ydResp.includes("[3,null,4]")) {
        statusEl.textContent = "⚠️ 服务端返回: " + res.ydResp.slice(0, 80);
        btn.disabled = false;
        btn.textContent = "重试一键降级";
        return;
      }

      statusEl.textContent = "✅ [3,null,4] 注入成功！正在跳转短信选择框...";
      const params = new URLSearchParams(location.search);
      let cont = params.get("continue");
      if (!cont) throw new Error("当前网址没有 continue 参数，请从 Cloud Shell Verify 进入");

      cont = cont.replace(/&idv_xdevice=[^&]*/g, "");
      cont = cont.replace(/([?&])authuser(&|$)/, "$1authuser=0$2");
      const targetUrl = cont + "&idv_xdevice=1";
      location.replace(targetUrl);
    } catch (e) {
      statusEl.textContent = "❌ " + e.message;
      btn.disabled = false;
      btn.textContent = "重试一键降级";
    }
  }
})();
