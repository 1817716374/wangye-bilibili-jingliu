// ==UserScript==
// @name         Bilibili Clean Feed
// @name:zh-CN   哔哩哔哩净流
// @namespace    https://local.codex/bilibili-clean-feed
// @version      0.4.1
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
      minFetchSize: 20,
      fetchPadding: 12,
      maxFetchSize: 36,
      domCleanIntervalMs: 2500,
      videoAdMaxDelayMs: 8000,
    };

    const PAGE = {
      isHomePage: location.hostname === 'www.bilibili.com' && location.pathname === '/',
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
    const adSignaturePattern =
      /cm\.bilibili\.com|ad_card|ad_logo|cm_mark|creative_id|linked_creative_id|trackid=web_pegasus|track_id=pbaes|source_id=5614|right_bottom\.adfloor|web-video-ad-cover|web-video-right-bottom-ad|web-video-activity-cover|sycp_brand|\/bfs\/sycp\//i;

    function log(...args) {
      if (CONFIG.debug) console.info('[Bilibili Clean Feed]', ...args);
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

    function hasAdSignature(value) {
      if (!value) return false;

      if (typeof value === 'string') {
        return adSignaturePattern.test(value);
      }

      try {
        return adSignaturePattern.test(JSON.stringify(value));
      } catch (_) {
        return false;
      }
    }

    function itemKey(item) {
      if (!item) return '';
      if (item.bvid) return `bvid:${item.bvid}`;
      if (item.goto && item.id) return `${item.goto}:${item.id}`;
      const archive = item.business_info && item.business_info.archive;
      if (archive && archive.bvid) return `bvid:${archive.bvid}`;
      return '';
    }

    function isBlockedFeedItem(item) {
      const business = item && item.business_info;
      const mark = business && business.business_mark;

      return Boolean(
        item &&
          (
            item.goto === 'ad' ||
            item.card_goto === 'ad' ||
            hasAdSignature(item) ||
            business && (
              business.is_ad === true ||
              business.is_ad_loc === true ||
              Number(business.cm_mark) === 1 ||
              Number(mark && mark.type) === 4 ||
              hasAdSignature([
                business.url,
                business.show_url,
                business.click_url,
                business.ad_cb,
              ].filter(Boolean).join(' '))
            )
          )
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

    function patchFetch() {
      const rawFetch = window.fetch;
      if (typeof rawFetch !== 'function') return;

      window.fetch = async function cleanFeedFetch(input, init) {
        const originalUrlText = getRequestUrl(input);
        if (!isHomeFeedApi(originalUrlText)) {
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
        log('feed cleaned', {
          requestedSize,
          fetchSize,
          removed: result.removed,
          returned: result.returned,
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
      if (adSignaturePattern.test(html)) return true;
      if (card.querySelector('a[href*="cm.bilibili.com"]')) return true;

      const hasRocketBoostIcon = card.querySelector('svg.vui_icon.bili-video-card__stats--icon');
      const hasAdLikeLink = card.querySelector(
        [
          'a[href*="ad_card"]',
          'a[href*="ad_logo"]',
          'a[href*="creative_id"]',
          'a[href*="linked_creative_id"]',
          'a[href*="trackid=web_pegasus"]',
          'a[href*="track_id=pbaes"]',
          'a[href*="source_id=5614"]',
        ].join(','),
      );
      return Boolean(hasAdLikeLink || (hasRocketBoostIcon && hasAdSignature(html)));
    }

    function removeHomeDomAds() {
      const cardSelector = '.bili-video-card, .feed-card, .floor-single-card';
      let removed = 0;

      document.querySelectorAll(cardSelector).forEach((card) => {
        if (!isBlockedHomeDomCard(card)) return;
        if (markAndRemove(card)) removed += 1;
      });

      document.querySelectorAll('a[href*="cm.bilibili.com"]').forEach((link) => {
        const card = link.closest(cardSelector) || link.closest('.bili-video-card__wrap');
        if (!card) return;
        if (markAndRemove(card)) removed += 1;
      });

      if (removed) log('home dom cards removed', removed);
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
      if (adReport && !adSignaturePattern.test(adReport.outerHTML || '')) {
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

      if (removed) log('video ads removed', removed);
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

      injectCss();
      scheduleClean();
      new MutationObserver(scheduleClean).observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
      setInterval(removeDomAds, CONFIG.domCleanIntervalMs);
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
