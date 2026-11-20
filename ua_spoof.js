(() => {
  // 只在插件自己降级出来的页面（携带 idv_xdevice=1）伪装 navigator，原生流程保持真实环境
  // 不篡改 window.innerWidth / innerHeight，避免触发 Google Closure 布局重绘导致页面重置
  if (!/[?&]idv_xdevice=1(&|$)/.test(location.search)) {
    return;
  }
  const IPAD_MINI_UA = "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
  Object.defineProperty(navigator, 'userAgent', { get: () => IPAD_MINI_UA, configurable: true });
  Object.defineProperty(navigator, 'appVersion', { get: () => "5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1", configurable: true });
  Object.defineProperty(navigator, 'platform', { get: () => 'iPad', configurable: true });
  Object.defineProperty(navigator, 'vendor', { get: () => 'Apple Computer, Inc.', configurable: true });
  Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5, configurable: true });
  Object.defineProperty(navigator, 'userAgentData', { get: () => undefined, configurable: true });
})();
