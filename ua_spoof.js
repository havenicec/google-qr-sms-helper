(() => {
  // 仅在非二维码页面（或已携带 idv_xdevice=1 / uplevelingstep / 验证码输入页）伪装 navigator 为 iPad Mini
  // 不篡改 window.innerWidth / innerHeight，避免触发 Google Closure 布局重绘导致页面重置
  const IPAD_MINI_UA = "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
  Object.defineProperty(navigator, 'userAgent', { get: () => IPAD_MINI_UA, configurable: true });
  Object.defineProperty(navigator, 'appVersion', { get: () => "5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1", configurable: true });
  Object.defineProperty(navigator, 'platform', { get: () => 'iPad', configurable: true });
  Object.defineProperty(navigator, 'vendor', { get: () => 'Apple Computer, Inc.', configurable: true });
  Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5, configurable: true });
  Object.defineProperty(navigator, 'userAgentData', { get: () => undefined, configurable: true });
})();
