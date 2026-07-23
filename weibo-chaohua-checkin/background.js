// 背景脚本：定时与补签逻辑
(function() {
  const ALARM_NAME = 'dailyCheckin';
  const STORAGE_KEYS = {
    settings: 'settings', // { enableDaily: boolean, dailyTime: 'HH:MM' }
    lastRunDate: 'lastRunDate', // 'YYYY-MM-DD'
    lastResult: 'lastResult', // { ts, totalTopics, checkedInBefore, newlyCheckedIn, failedCheckin }
    signedTopics: 'signedTopics', // 今日已签超话名称列表
  };

  class PromiseQueue {
    constructor({ concurrency = 1, minTimeout = 800, maxTimeout = 1500 } = {}) {
      this.queue = [];
      this.running = 0;
      this.concurrency = concurrency;
      this.minTimeout = minTimeout;
      this.maxTimeout = maxTimeout;
    }
    add(fn) {
      return new Promise((resolve, reject) => {
        const task = async () => {
          try {
            const res = await fn();
            const randomDelay = this.minTimeout + Math.floor(Math.random() * (this.maxTimeout - this.minTimeout));
            await new Promise(r => setTimeout(r, randomDelay));
            resolve(res);
          } catch (err) {
            reject(err);
          } finally {
            this.running--;
            this.processQueue();
          }
        };
        this.queue.push(task);
        this.processQueue();
      });
    }
    processQueue() {
      while (this.running < this.concurrency && this.queue.length > 0) {
        this.running++;
        const task = this.queue.shift();
        task();
      }
    }
  }

  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'MWeibo-Pwa': '1',
    'Referer': 'https://m.weibo.cn/p/tabbar?containerid=100803_-_recentvisit&page_type=tabbar',
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': typeof navigator !== 'undefined' ? navigator.userAgent : 'Mozilla/5.0',
  };
  const WEIBO_TAB_URL = 'https://m.weibo.cn/p/tabbar?containerid=100803_-_recentvisit';

  function fmtDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function parseTimeToNextMs(timeStr) {
    // timeStr: 'HH:MM' 本地时区
    const [hh, mm] = (timeStr || '09:00').split(':').map(n => parseInt(n, 10));
    const now = new Date();
    const target = new Date();
    target.setHours(hh, mm, 0, 0);
    if (target.getTime() <= now.getTime()) {
      // 明天
      target.setDate(target.getDate() + 1);
    }
    return target.getTime();
  }

  async function getFromStorage(key) {
    return new Promise(resolve => chrome.storage.local.get([key], items => resolve(items[key])));
  }

  async function setInStorage(obj) {
    return new Promise(resolve => chrome.storage.local.set(obj, resolve));
  }

  async function loadSettings() {
    const s = await getFromStorage(STORAGE_KEYS.settings);
    return s || { enableDaily: false, dailyTime: '09:00' };
  }

  async function setupAlarm() {
    const settings = await loadSettings();
    await chrome.alarms.clear(ALARM_NAME);
    if (settings.enableDaily) {
      const when = parseTimeToNextMs(settings.dailyTime);
      chrome.alarms.create(ALARM_NAME, { when, periodInMinutes: 24 * 60 });
      await setInStorage({ nextRun: when });
    } else {
      await setInStorage({ nextRun: null });
    }
  }

  async function checkLogin() {
    try {
      const resp = await fetch('https://m.weibo.cn/api/config', { credentials: 'include', headers });
      if (!resp.ok) return false;
      const data = await resp.json();
      return !!(data && data.data && data.data.login);
    } catch (e) {
      return false;
    }
  }

  async function fetchWithRetry(input, init = {}, opts = {}) {
    const { retries = 3, timeoutMs = 15000, backoffMs = 300 } = opts;
    let attempt = 0;
    while (true) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const resp = await fetch(input, { ...init, signal: ctrl.signal });
        clearTimeout(t);
        if (resp.ok) return resp;
        if (![429, 500, 502, 503, 504].includes(resp.status)) return resp;
        if (attempt >= retries) return resp;
      } catch (e) {
        clearTimeout(t);
        if (attempt >= retries) throw e;
      }
      attempt += 1;
      await new Promise(r => setTimeout(r, backoffMs * attempt));
    }
  }

  async function getSupertopicList() {
    return await pageGetSupertopicList();
  }

  // 在页面上下文中执行代码，确保请求携带页面的 Cookie/Referer/Sec-Fetch 等头部
  async function ensureWeiboTab() {
    const tabs = await chrome.tabs.query({ url: 'https://m.weibo.cn/*' });
    if (tabs && tabs.length > 0) return tabs[0].id;
    const tab = await chrome.tabs.create({ url: WEIBO_TAB_URL, active: false });
    return tab.id;
  }

  async function execInWeibo(tabId, func, args = []) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func,
      args,
    });
    return results && results[0] ? results[0].result : null;
  }

  async function pagePerformCheckin(scheme) {
    const tabId = await ensureWeiboTab();
    const result = await execInWeibo(tabId, async (s) => {
      let attempt = 0;
      while (true) {
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 15000);
          const resp = await fetch(`https://m.weibo.cn${s}`, { credentials: 'include', signal: ctrl.signal });
          clearTimeout(t);
          const data = await resp.json();
          if (data && data.ok === 1) return { ok: true };
          if (![429, 500, 502, 503, 504].includes(resp.status) || attempt >= 3) return { ok: false, data };
        } catch (e) {
          if (attempt >= 3) return { ok: false, error: String(e) };
        }
        attempt += 1;
        await new Promise(r => setTimeout(r, 300 * attempt));
      }
    }, [scheme]);
    return result;
  }

  async function pageGetSupertopicList() {
    const tabId = await ensureWeiboTab();
    const result = await execInWeibo(tabId, async () => {
      const allCards = [];
      let pageCount = 1;
      let sinceId = undefined;
      try {
        while (true) {
          const params = new URLSearchParams({ containerid: '100803_-_followsuper' });
          if (sinceId) params.set('since_id', sinceId);
          const url = `https://m.weibo.cn/api/container/getIndex?${params.toString()}`;
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 15000);
          const resp = await fetch(url, { credentials: 'include', signal: ctrl.signal });
          clearTimeout(t);
          if (!resp.ok) break;
          const data = await resp.json();
          if (data.ok !== 1) break;
          const cards = data?.data?.cards || [];
          allCards.push(...cards);
          const info = data?.data?.cardlistInfo || {};
          sinceId = info.since_id;
          if (!sinceId) break;
          pageCount += 1;
          await new Promise(r => setTimeout(r, 300 + Math.floor(Math.random() * 300)));
        }
      } catch (e) {
        return null;
      }
      if (allCards.length) {
        return { ok: 1, data: { cards: allCards, cardlistInfo: { total_pages: pageCount, total_cards: allCards.length } } };
      }
      return null;
    }, []);
    return result;
  }

  async function performCheckin(topicName, scheme) {
    try {
      if (!scheme || !scheme.startsWith('/api/container/button')) return false;
      let ok = false;
      for (let i = 0; i < 3 && !ok; i++) {
        const result = await pagePerformCheckin(scheme);
        ok = !!(result && result.ok);
        if (!ok) await new Promise(r => setTimeout(r, 300 + Math.floor(Math.random() * 300)));
      }
      return ok;
    } catch (e) {
      return false;
    }
  }

  async function autoCheckin() {
    const ok = await checkLogin();
    if (!ok) {
      await setInStorage({ lastResult: { ts: Date.now(), error: 'not_logged_in' } });
      return false;
    }
    let totalTopics = 0;
    let checkedInBefore = 0;
    let newlyCheckedIn = 0;
    let failedCheckin = 0;
    const data = await getSupertopicList();
    if (!data) {
      await setInStorage({ lastResult: { ts: Date.now(), error: 'list_failed' } });
      return false;
    }

    const todayStr = fmtDate(new Date());
    const savedRunDate = await getFromStorage(STORAGE_KEYS.lastRunDate);
    let signedTopics = (await getFromStorage(STORAGE_KEYS.signedTopics)) || [];
    if (savedRunDate !== todayStr) {
      signedTopics = [];
    }

    const cards = data?.data?.cards || [];
    const queue = new PromiseQueue({ concurrency: 1, timeout: 400 });
    const tasks = [];

    for (const card of cards) {
      const groups = card?.card_group || [];
      for (const item of groups) {
        if (!item?.title_sub || !item?.buttons) continue;
        totalTopics += 1;
        const topicName = item.title_sub;

        if (signedTopics.includes(topicName)) {
          checkedInBefore += 1;
          continue;
        }

        let canCheckin = false;
        let checkinScheme = '';
        for (const btn of item.buttons) {
          const name = btn?.name || '';
          if (name === '签到') {
            canCheckin = true;
            checkinScheme = btn?.scheme || '';
            break;
          } else if (['已签', '已签到', '明日再来'].includes(name)) {
            checkedInBefore += 1;
            if (!signedTopics.includes(topicName)) {
              signedTopics.push(topicName);
            }
            break;
          }
        }
        if (canCheckin && checkinScheme) {
          tasks.push({ topicName, checkinScheme });
        }
      }
    }

    await setInStorage({ [STORAGE_KEYS.signedTopics]: signedTopics, [STORAGE_KEYS.lastRunDate]: todayStr });

    for (const task of tasks) {
      const success = await queue.add(() => performCheckin(task.topicName, task.checkinScheme));
      if (success) {
        newlyCheckedIn += 1;
        if (!signedTopics.includes(task.topicName)) {
          signedTopics.push(task.topicName);
        }
      } else {
        failedCheckin += 1;
      }
      await setInStorage({ [STORAGE_KEYS.signedTopics]: signedTopics });
    }

    await setInStorage({
      [STORAGE_KEYS.lastRunDate]: todayStr,
      [STORAGE_KEYS.signedTopics]: signedTopics,
      lastResult: {
        ts: Date.now(),
        totalTopics, checkedInBefore, newlyCheckedIn, failedCheckin,
      }
    });
    return true;
  }

  async function checkMakeup() {
    const settings = await loadSettings();
    if (!settings.enableDaily) return;
    const todayStr = fmtDate(new Date());
    const lastRunDate = await getFromStorage(STORAGE_KEYS.lastRunDate);
    const nextRunMs = parseTimeToNextMs(settings.dailyTime);
    const now = Date.now();
    // 如果今天的计划时间已过，并且今天没有跑过，则补签
    const targetToday = (() => {
      const [hh, mm] = settings.dailyTime.split(':').map(n => parseInt(n, 10));
      const d = new Date(); d.setHours(hh, mm, 0, 0); return d.getTime();
    })();
    if ((!lastRunDate || lastRunDate !== todayStr) && now > targetToday) {
      await autoCheckin();
    }
    // 重置闹钟到下一次
    await setupAlarm();
  }

  // 消息交互
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        if (msg?.type === 'updateSchedule') {
          await setInStorage({ [STORAGE_KEYS.settings]: msg.settings });
          await setupAlarm();
          sendResponse({ ok: true });
        } else if (msg?.type === 'getSettings') {
          const s = await loadSettings();
          const nextRun = await getFromStorage('nextRun');
          sendResponse({ ok: true, settings: s, nextRun });
      } else if (msg?.type === 'runCheckinNow') {
        const ok = await autoCheckin();
        sendResponse({ ok });
      } else if (msg?.type === 'pagePerformCheckin') {
        const { scheme } = msg;
        const result = await pagePerformCheckin(scheme);
        sendResponse(result || { ok: false });
      } else if (msg?.type === 'pageGetSupertopicList') {
        const result = await pageGetSupertopicList();
        sendResponse(result || { ok: false });
      } else if (msg?.type === 'getLastResult') {
        const r = await getFromStorage('lastResult');
        sendResponse({ ok: true, result: r });
      } else {
        sendResponse({ ok: false, error: 'unknown_message' });
        }
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true; // async
  });

  // 闹钟触发
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm && alarm.name === ALARM_NAME) {
      await autoCheckin();
      await setupAlarm(); // 更新下一次
    }
  });

  // 启动与首次安装时的补签检查
  chrome.runtime.onStartup.addListener(() => { checkMakeup(); });
  chrome.runtime.onInstalled.addListener(() => { checkMakeup(); });
})();