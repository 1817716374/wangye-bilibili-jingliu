// ==UserScript==
// @name         Bilibili Clean Feed
// @name:zh-CN   哔哩哔哩净流
// @namespace    https://local.codex/bilibili-clean-feed
// @version      0.5.0
// @description  Remove Bilibili homepage ad/rocket cards, refill the feed, and hide video-page side ads.
// @description:zh-CN  过滤哔哩哔哩首页广告、推流卡片、视频页右侧广告和游戏活动推广。
// @author       千林
// @license      MIT
// @homepageURL  https://github.com/1817716374/wangye-bilibili-jingliu
// @supportURL   https://github.com/1817716374/wangye-bilibili-jingliu/issues
// @downloadURL  https://github.com/1817716374/wangye-bilibili-jingliu/raw/main/bilibili-clean-feed.user.js
// @updateURL    https://github.com/1817716374/wangye-bilibili-jingliu/raw/main/bilibili-clean-feed.user.js
// @compatible   chrome
// @compatible   edge
// @contact      QQ 1817716374
// @match        https://www.bilibili.com/*
// @run-at       document-start
// @inject-into  page
// @grant        none
// @noframes
// ==/UserScript==

(function installIntoPage() {
  'use strict';

  const pageMain = function pageMain() {
    'use strict';

    const CONFIG = {
      debug: false,
      feedApiPath: '/x/web-interface/wbi/index/top/feed/rcmd',
      settingsKey: 'bilibili-clean-feed-settings',
      minFetchSize: 20,
      fetchPadding: 12,
      maxFetchSize: 36,
      domCleanIntervalMs: 2500,
      videoAdMaxDelayMs: 8000,
      commentWarmupDelayMs: 120,
    };

    const DEFAULT_SETTINGS = {
      blockBiliAds: true,
      blockPromotedVideos: true,
      warmupComments: true,
    };

    const PAGE = {
      isHomePage: location.hostname === 'www.bilibili.com' && (location.pathname === '/' || location.pathname === '/index.html'),
      isVideoPage: location.hostname === 'www.bilibili.com' && /^\/video\//.test(location.pathname),
    };

    if (window.__BILIBILI_CLEAN_FEED_INSTALLED__) return;
    if (!PAGE.isHomePage && !PAGE.isVideoPage) return;

    Object.defineProperty(window, '__BILIBILI_CLEAN_FEED_INSTALLED__', {
      value: true,
      configurable: false,
      enumerable: false,
    });

    const seenReturnedItems = new Set();
    const installedAt = Date.now();
    const hardAdSignaturePattern =
      /cm\.bilibili\.com|ad_card|ad_logo|cm_mark|right_bottom\.adfloor|web-video-ad-cover|web-video-right-bottom-ad|web-video-activity-cover|sycp_brand|\/bfs\/sycp\//i;
    const promotedCreativeParamPattern = /[?&](?:creative_id|linked_creative_id)=([^&#]+)/i;
    const promotedContextPattern = /[?&](?:trackid=web_pegasus|track_id=pbaes|source_id=|request_id=)/i;

    function loadSettings() {
      try {
        const saved = JSON.parse(localStorage.getItem(CONFIG.settingsKey) || '{}');
        return {
          ...DEFAULT_SETTINGS,
          ...saved,
        };
      } catch (_) {
        return { ...DEFAULT_SETTINGS };
      }
    }

    let settings = loadSettings();

    function saveSettings(nextSettings) {
      settings = {
        ...DEFAULT_SETTINGS,
        ...nextSettings,
      };
      localStorage.setItem(CONFIG.settingsKey, JSON.stringify(settings));
      window.dispatchEvent(new CustomEvent('bilibili-clean-feed-settings-change', { detail: settings }));
    }

    function log(...args) {
      if (CONFIG.debug) console.info('[哔哩哔哩净流]', ...args);
    }

    function toUrl(value) {
      try {
        return new URL(String(value), location.href);
      } catch (_) {
        return null;
      }
    }

    function getRequestUrl(input) {
      if (typeof input === 'string') return input;
      if (input && typeof input.url === 'string') return input.url;
      return String(input || '');
    }

    function isHomeFeedApi(urlText) {
      const url = toUrl(urlText);
      return Boolean(url && url.hostname.endsWith('bilibili.com') && url.pathname === CONFIG.feedApiPath);
    }

    function isMeaningfulPromotionValue(value) {
      return value !== undefined && value !== null && value !== '' && value !== 0 && value !== '0';
    }

    function readPromotionSignals(value, depth = 0, signals = { hardAd: false, creative: false, context: false }) {
      if (!value) return signals;

      if (typeof value === 'string') {
        if (hardAdSignaturePattern.test(value)) signals.hardAd = true;
        if (promotedCreativeParamPattern.test(value)) signals.creative = true;
        if (promotedContextPattern.test(value)) signals.context = true;
        return signals;
      }

      if (typeof value !== 'object' || depth > 6) return signals;

      Object.keys(value).forEach((key) => {
        const child = value[key];
        const normalizedKey = String(key).toLowerCase();

        if ((normalizedKey === 'creative_id' || normalizedKey === 'linked_creative_id') && isMeaningfulPromotionValue(child)) {
          signals.creative = true;
        }

        if (typeof child === 'string' || typeof child === 'number') {
          const text = String(child);
          if (hardAdSignaturePattern.test(text)) signals.hardAd = true;
          if (promotedCreativeParamPattern.test(text)) signals.creative = true;
          if (promotedContextPattern.test(text)) signals.context = true;
        } else {
          readPromotionSignals(child, depth + 1, signals);
        }
      });

      return signals;
    }

    function hasHardAdSignature(value) {
      return readPromotionSignals(value).hardAd;
    }

    function hasPromotedCreativeSignature(value) {
      const signals = readPromotionSignals(value);
      return signals.creative || (signals.hardAd && signals.context);
    }

    function itemKey(item) {
      if (!item) return '';
      if (item.bvid) return `bvid:${item.bvid}`;
      if (item.goto && item.id) return `${item.goto}:${item.id}`;
      const archive = item.business_info && item.business_info.archive;
      if (archive && archive.bvid) return `bvid:${archive.bvid}`;
      return '';
    }

    function isBiliAdFeedItem(item) {
      const business = item && item.business_info;
      const mark = business && business.business_mark;
      const promotionSignals = readPromotionSignals(item);

      return Boolean(
        item &&
          (
            item.goto === 'ad' ||
            item.card_goto === 'ad' ||
            promotionSignals.hardAd ||
            business && (
              business.is_ad === true ||
              Number(business.cm_mark) === 1 ||
              Number(mark && mark.type) === 4 ||
              hasHardAdSignature([
                business.url,
                business.show_url,
                business.click_url,
                business.ad_cb,
              ].filter(Boolean).join(' '))
            )
          )
      );
    }

    function isPromotedVideoFeedItem(item) {
      return Boolean(item && readPromotionSignals(item).creative);
    }

    function isBlockedFeedItem(item) {
      return Boolean(
        settings.blockBiliAds && isBiliAdFeedItem(item) ||
        settings.blockPromotedVideos && isPromotedVideoFeedItem(item),
      );
    }

    function cleanFeedPayload(payload, requestedSize) {
      const items = payload && payload.data && payload.data.item;
      if (!Array.isArray(items)) return { changed: false, removed: 0, returned: 0 };

      const cleaned = [];
      let removed = 0;

      for (const item of items) {
        if (isBlockedFeedItem(item)) {
          removed += 1;
          continue;
        }

        const key = itemKey(item);
        if (key && seenReturnedItems.has(key)) continue;

        cleaned.push(item);
        if (cleaned.length >= requestedSize) break;
      }

      for (const item of cleaned) {
        const key = itemKey(item);
        if (key) seenReturnedItems.add(key);
      }

      payload.data.item = cleaned;
      return {
        changed: removed > 0 || cleaned.length !== items.length,
        removed,
        returned: cleaned.length,
      };
    }

    function withIncludedCredentials(init) {
      const nextInit = init ? { ...init } : {};
      if (!nextInit.credentials || nextInit.credentials === 'same-origin') {
        nextInit.credentials = 'include';
      }
      return nextInit;
    }

    function makeLargerFeedRequest(input, init, targetUrl) {
      const nextInit = withIncludedCredentials(init);
      if (input instanceof Request) {
        return [new Request(targetUrl, input), nextInit];
      }
      return [targetUrl, nextInit];
    }

    function isCommentRootElement(element) {
      if (!element || element.nodeType !== 1) return false;
      const tagName = String(element.tagName || '').toUpperCase();
      if (tagName === 'BILI-COMMENTS') return true;

      const text = [
        tagName,
        element.id,
        element.className,
        element.getAttribute('data-testid'),
        element.getAttribute('data-module'),
        element.getAttribute('aria-label'),
      ].filter(Boolean).join(' ');

      return /BILI-COMMENTS|BILI-COMMENT-BOX|comment|reply/i.test(text);
    }

    function createCommentWarmupEntry(target) {
      const rect = target.getBoundingClientRect();
      return {
        time: performance.now(),
        target,
        rootBounds: null,
        boundingClientRect: rect,
        intersectionRect: rect,
        intersectionRatio: 1,
        isIntersecting: true,
      };
    }

    const commentObserverRecords = [];
    let currentVideoPath = location.pathname;

    function fireCommentWarmup(callback, observer, target) {
      if (!settings.warmupComments) return;
      if (!target || !document.documentElement.contains(target)) return;

      try {
        callback([createCommentWarmupEntry(target)], observer);
        log('已预热评论区懒加载');
      } catch (error) {
        log('评论区懒加载预热失败', error);
      }
    }

    function scheduleCommentWarmup(callback, observer, target, warmedTargets) {
      if (!settings.warmupComments) return;
      if (!isCommentRootElement(target)) return;
      if (warmedTargets && warmedTargets.has(target)) return;
      if (warmedTargets) warmedTargets.add(target);

      commentObserverRecords.push({ callback, observer, target });
      [CONFIG.commentWarmupDelayMs, 360, 900].forEach((delay) => {
        setTimeout(() => fireCommentWarmup(callback, observer, target), delay);
      });
    }

    function warmupExistingCommentObservers() {
      if (!settings.warmupComments) return;
      commentObserverRecords.forEach(({ callback, observer, target }) => {
        [0, 240, 700].forEach((delay) => {
          setTimeout(() => fireCommentWarmup(callback, observer, target), delay);
        });
      });
    }

    function watchVideoRouteChangeForCommentWarmup() {
      if (window.__BILIBILI_CLEAN_FEED_ROUTE_PATCHED__) return;

      Object.defineProperty(window, '__BILIBILI_CLEAN_FEED_ROUTE_PATCHED__', {
        value: true,
        configurable: false,
        enumerable: false,
      });

      const checkRoute = () => {
        if (location.pathname === currentVideoPath) return;
        currentVideoPath = location.pathname;
        if (/^\/video\//.test(location.pathname)) {
          setTimeout(warmupExistingCommentObservers, 300);
          setTimeout(warmupExistingCommentObservers, 1200);
        }
      };

      ['pushState', 'replaceState'].forEach((method) => {
        const raw = history[method];
        history[method] = function patchedHistoryMethod(...args) {
          const result = raw.apply(this, args);
          setTimeout(checkRoute, 0);
          return result;
        };
      });

      window.addEventListener('popstate', () => setTimeout(checkRoute, 0));
    }

    function warmupVideoCommentsObserver() {
      if (!PAGE.isVideoPage || typeof window.IntersectionObserver !== 'function') return;
      if (window.__BILIBILI_CLEAN_FEED_COMMENT_IO_PATCHED__) return;

      Object.defineProperty(window, '__BILIBILI_CLEAN_FEED_COMMENT_IO_PATCHED__', {
        value: true,
        configurable: false,
        enumerable: false,
      });

      const NativeIntersectionObserver = window.IntersectionObserver;
      const warmedTargets = new WeakSet();

      window.IntersectionObserver = function BcfIntersectionObserver(callback, options) {
        const observer = new NativeIntersectionObserver(callback, options);
        const nativeObserve = observer.observe.bind(observer);

        observer.observe = function observeWithCommentWarmup(target) {
          nativeObserve(target);
          scheduleCommentWarmup(callback, observer, target, warmedTargets);
        };

        return observer;
      };

      window.IntersectionObserver.prototype = NativeIntersectionObserver.prototype;
      Object.defineProperty(window.IntersectionObserver, 'name', {
        value: 'IntersectionObserver',
      });
    }

    function patchFetch() {
      const rawFetch = window.fetch;
      if (typeof rawFetch !== 'function') return;

      window.fetch = async function cleanFeedFetch(input, init) {
        const originalUrlText = getRequestUrl(input);
        if (!isHomeFeedApi(originalUrlText)) {
          return rawFetch.apply(this, arguments);
        }

        if (!settings.blockBiliAds && !settings.blockPromotedVideos) {
          return rawFetch.apply(this, arguments);
        }

        const originalUrl = toUrl(originalUrlText);
        const requestedSize = Math.max(1, Number(originalUrl.searchParams.get('ps') || 12));
        const fetchSize = Math.min(
          CONFIG.maxFetchSize,
          Math.max(CONFIG.minFetchSize, requestedSize + CONFIG.fetchPadding),
        );

        const upstreamUrl = new URL(originalUrl.href);
        upstreamUrl.searchParams.set('ps', String(fetchSize));

        const [nextInput, nextInit] = makeLargerFeedRequest(input, init, upstreamUrl.href);
        const response = await rawFetch.call(this, nextInput, nextInit);
        const payload = await response.clone().json().catch(() => null);

        if (!payload || !payload.data || !Array.isArray(payload.data.item)) {
          return response;
        }

        const result = cleanFeedPayload(payload, requestedSize);
        log('首页推荐流已过滤', {
          请求数量: requestedSize,
          拉取数量: fetchSize,
          移除数量: result.removed,
          返回数量: result.returned,
        });

        const headers = new Headers(response.headers);
        headers.set('content-type', 'application/json; charset=utf-8');
        headers.delete('content-length');
        headers.delete('content-encoding');

        return new Response(JSON.stringify(payload), {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      };
    }

    function markAndRemove(element) {
      if (!element || element.dataset.bcfRemoved === '1') return false;
      element.dataset.bcfRemoved = '1';
      element.remove();
      return true;
    }

    function isBlockedHomeDomCard(card) {
      if (!card || card.dataset.bcfRemoved === '1') return false;

      const html = card.outerHTML || '';
      if (settings.blockBiliAds && hasHardAdSignature(html)) return true;
      if (settings.blockBiliAds && card.querySelector('a[href*="cm.bilibili.com"]')) return true;

      const hasRocketBoostIcon = card.querySelector('svg.vui_icon.bili-video-card__stats--icon');
      const hasAdLikeLink = card.querySelector(
        [
          'a[href*="ad_card"]',
          'a[href*="ad_logo"]',
          'a[href*="creative_id="]',
          'a[href*="linked_creative_id="]',
        ].join(','),
      );
      return Boolean(settings.blockPromotedVideos && (hasAdLikeLink || (hasRocketBoostIcon && hasPromotedCreativeSignature(html))));
    }

    function removeHomeDomAds() {
      const cardSelector = '.bili-video-card, .feed-card, .floor-single-card';
      let removed = 0;

      document.querySelectorAll(cardSelector).forEach((card) => {
        if (!isBlockedHomeDomCard(card)) return;
        if (markAndRemove(card)) removed += 1;
      });

      if (settings.blockBiliAds) {
        document.querySelectorAll('a[href*="cm.bilibili.com"]').forEach((link) => {
          const card = link.closest(cardSelector) || link.closest('.bili-video-card__wrap');
          if (!card) return;
          if (markAndRemove(card)) removed += 1;
        });
      }

      if (removed) log('首页卡片已移除', removed);
    }

    function getVideoAdContainer(node) {
      if (!node || node.nodeType !== 1) return null;

      const wholeCard = node.closest('.video-card-ad-small');
      if (wholeCard) return wholeCard;

      const knownContainer = node.closest([
        '#slide_ad',
        '.activity-m-v1',
        '.activity-m',
        '.ad-report.strip-ad.left-banner',
        '.ad-report.ad-floor-exp.right-bottom-banner',
        '.video-page-game-card-small',
        '.game-card-ad',
      ].join(','));
      if (knownContainer) return knownContainer;

      const adReport = node.closest('.ad-report');
      if (adReport && !hasHardAdSignature(adReport.outerHTML || '')) {
        return null;
      }

      for (let current = node; current && current !== document.body; current = current.parentElement) {
        const rect = current.getBoundingClientRect();
        const className = String(current.className || '');
        if (/(^|\s)right-container(\s|$)|(^|\s)left-container(\s|$)|bpx-player|video-container/.test(className)) {
          return null;
        }
        if (rect.width >= 240 && rect.height >= 60 && rect.width <= 760 && rect.height <= 360) {
          return current;
        }
      }

      return null;
    }

    function removeVideoPageAds() {
      const normalRecommendImagesLoaded = Boolean(
        document.querySelector('.right-container .video-page-card-small img[src*="web-video-rcmd-cover"], .right-container .video-page-card-small img[src*="/bfs/archive/"]'),
      );
      if (!normalRecommendImagesLoaded && Date.now() - installedAt < CONFIG.videoAdMaxDelayMs) {
        return;
      }

      let removed = 0;
      const directSelectors = [
        '.video-card-ad-small',
        '#slide_ad',
        '.activity-m-v1',
        '.activity-m',
        '.ad-report.strip-ad.left-banner',
        '.ad-report.ad-floor-exp.right-bottom-banner',
        '.video-page-game-card-small',
        '.game-card-ad',
      ].join(',');

      document.querySelectorAll(directSelectors).forEach((element) => {
        if (markAndRemove(element)) removed += 1;
      });

      document.querySelectorAll([
        'a[href*="cm.bilibili.com"]',
        'a[href*="right_bottom.adfloor"]',
        'a[href*="ad_card"]',
        'img[src*="web-video-ad-cover"]',
        'img[src*="web-video-right-bottom-ad"]',
        'img[src*="web-video-activity-cover"]',
        'img[src*="sycp_brand"]',
        'img[src*="/bfs/sycp/"]',
      ].join(',')).forEach((node) => {
        const container = getVideoAdContainer(node);
        if (markAndRemove(container)) removed += 1;
      });

      if (removed) log('视频页广告已移除', removed);
    }

    function removeDomAds() {
      if (PAGE.isHomePage) removeHomeDomAds();
      if (PAGE.isVideoPage) removeVideoPageAds();
    }

    function injectCss() {
      if (!PAGE.isVideoPage || document.getElementById('bilibili-clean-feed-style')) return;

      const style = document.createElement('style');
      style.id = 'bilibili-clean-feed-style';
      style.textContent = `${[
        '.video-card-ad-small',
        '#slide_ad',
        '.activity-m-v1',
        '.activity-m',
        '.ad-report.strip-ad.left-banner',
        '.ad-report.ad-floor-exp.right-bottom-banner',
        '.video-page-game-card-small',
        '.game-card-ad',
      ].join(',')}{display:none!important;visibility:hidden!important;max-height:0!important;margin:0!important;padding:0!important;overflow:hidden!important;}`;

      (document.head || document.documentElement).appendChild(style);
    }

    function mountSettingsPanel() {
      if (document.getElementById('bilibili-clean-feed-panel')) return;
      if (!document.body) {
        setTimeout(mountSettingsPanel, 100);
        return;
      }

      const root = document.createElement('div');
      root.id = 'bilibili-clean-feed-panel';
      root.innerHTML = `
        <button class="bcf-fab" type="button" title="哔哩哔哩净流设置">净流</button>
        <div class="bcf-panel" hidden>
          <div class="bcf-title">哔哩哔哩净流</div>
          <label class="bcf-row">
            <span>过滤 B 站广告</span>
            <input type="checkbox" data-key="blockBiliAds">
          </label>
          <label class="bcf-row">
            <span>过滤 UP 推流</span>
            <input type="checkbox" data-key="blockPromotedVideos">
          </label>
          <label class="bcf-row">
            <span>提前加载评论区</span>
            <input type="checkbox" data-key="warmupComments">
          </label>
        </div>
      `;

      const style = document.createElement('style');
      style.id = 'bilibili-clean-feed-panel-style';
      style.textContent = `
        #bilibili-clean-feed-panel{position:fixed;right:18px;bottom:22px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:#18191c}
        #bilibili-clean-feed-panel .bcf-fab{height:34px;min-width:50px;border:0;border-radius:6px;background:#00aeec;color:#fff;font-size:13px;font-weight:600;box-shadow:0 4px 14px rgba(0,0,0,.18);cursor:pointer}
        #bilibili-clean-feed-panel .bcf-panel{position:absolute;right:0;bottom:44px;width:220px;padding:12px;border:1px solid rgba(0,0,0,.08);border-radius:8px;background:rgba(255,255,255,.98);box-shadow:0 8px 28px rgba(0,0,0,.18)}
        #bilibili-clean-feed-panel .bcf-title{font-size:14px;font-weight:700;margin:0 0 8px}
        #bilibili-clean-feed-panel .bcf-row{display:flex;align-items:center;justify-content:space-between;gap:12px;height:34px;font-size:13px;white-space:nowrap}
        #bilibili-clean-feed-panel input{width:34px;height:18px;accent-color:#00aeec;cursor:pointer}
      `;

      const button = root.querySelector('.bcf-fab');
      const panel = root.querySelector('.bcf-panel');
      const inputs = Array.from(root.querySelectorAll('input[data-key]'));

      const syncInputs = () => {
        inputs.forEach((input) => {
          input.checked = Boolean(settings[input.dataset.key]);
        });
      };

      button.addEventListener('click', () => {
        panel.hidden = !panel.hidden;
      });

      inputs.forEach((input) => {
        input.addEventListener('change', () => {
          saveSettings({
            ...settings,
            [input.dataset.key]: input.checked,
          });
          syncInputs();
          removeDomAds();
          if (PAGE.isVideoPage && settings.warmupComments) {
            warmupExistingCommentObservers();
          }
        });
      });

      window.addEventListener('bilibili-clean-feed-settings-change', syncInputs);
      syncInputs();

      document.documentElement.appendChild(style);
      document.body.appendChild(root);
    }

    function startDomCleaner() {
      let scheduled = false;
      const scheduleClean = () => {
        if (scheduled) return;
        scheduled = true;
        setTimeout(() => {
          scheduled = false;
          injectCss();
          removeDomAds();
        }, 80);
      };

      mountSettingsPanel();
      injectCss();
      scheduleClean();
      new MutationObserver(scheduleClean).observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
      setInterval(removeDomAds, CONFIG.domCleanIntervalMs);
    }

    if (PAGE.isVideoPage) {
      warmupVideoCommentsObserver();
      watchVideoRouteChangeForCommentWarmup();
    }
    if (PAGE.isHomePage) patchFetch();

    if (document.documentElement) {
      startDomCleaner();
    } else {
      document.addEventListener('DOMContentLoaded', startDomCleaner, { once: true });
    }
  };

  function inject() {
    const root = document.documentElement || document.head || document.body;
    if (!root) {
      setTimeout(inject, 0);
      return;
    }

    const script = document.createElement('script');
    script.textContent = `(${pageMain.toString()})();`;
    root.appendChild(script);
    script.remove();
  }

  inject();
})();
