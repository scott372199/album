/**
 * 热更新探针：常驻页面（照片墙）定时问一次「现在的最新版本是哪个」。
 * 用独立的小文件 version.json，命中后只拉一次新 manifest，不刷新页面。
 */

const BASE_INTERVAL = 600000; // 10 分钟
const BACKOFF = [30000, 60000, 120000, 300000, 600000];

export function startVersionWatch({ currentRev, onUpdate, onState }) {
  let timer = null;
  let stopped = false;
  let failures = 0;
  let rev = currentRev;

  function report(state) {
    if (typeof onState === 'function') onState(state);
  }

  async function tick() {
    if (stopped) return;
    if (document.visibilityState === 'hidden') {
      schedule(BASE_INTERVAL);
      return;
    }
    try {
      const response = await fetch(`data/version.json?_=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(String(response.status));
      const version = await response.json();
      failures = 0;
      report('online');

      if (version.rev && version.rev !== rev) {
        const manifestResponse = await fetch(version.manifest, { cache: 'default' });
        if (!manifestResponse.ok) throw new Error(String(manifestResponse.status));
        const manifest = await manifestResponse.json();
        rev = version.rev;
        await onUpdate?.(manifest, version);
      }
      schedule(BASE_INTERVAL);
    } catch {
      failures += 1;
      report('offline');
      schedule(BACKOFF[Math.min(failures - 1, BACKOFF.length - 1)]);
    }
  }

  function schedule(ms) {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(tick, ms);
  }

  document.addEventListener('visibilitychange', () => {
    if (stopped) return;
    if (document.visibilityState === 'visible') {
      failures = 0;
      schedule(1500);
    }
  });

  schedule(BASE_INTERVAL);

  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
    checkNow() {
      failures = 0;
      schedule(0);
    },
  };
}
