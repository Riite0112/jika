(() => {
  "use strict";

  const JIKA_BADGE_CLASS = "jika-badge";
  const JIKA_WRAP_CLASS = "jika-price-wrap";
  const JIKA_PROCESSED_ATTR = "data-jika-processed";
  const DEFAULT_SETTINGS = {
    enabled: true,
    hourlyWage: 1500,
    minPrice: 500,
    disabledDomains: []
  };
  const PRICE_PATTERN =
    /([¥￥]\s*(?:[0-9０-９]{1,3}(?:[,，][0-9０-９]{3})+|[0-9０-９]+)|(?:[0-9０-９]{1,3}(?:[,，][0-9０-９]{3})+|[0-9０-９]+)\s*円)/g;
  const PRICE_SIGNAL_PATTERN = /[¥￥円]/;
  const AMAZON_CURRENT_PRICE_SELECTOR = [
    "#apex-pricetopay-accessibility-label ~ .a-price.priceToPay.apex-pricetopay-value",
    "#apex_offerDisplay_desktop #corePrice_feature_div .a-price.apex-pricetopay-value"
  ].join(",");
  const MUTATION_DEBOUNCE_MS = 500;
  const MAX_PENDING_ROOTS = 80;
  const SKIP_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "INPUT",
    "TEXTAREA",
    "SELECT",
    "OPTION"
  ]);
  const HIDDEN_PRICE_CLASSES = new Set([
    "a-offscreen",
    "s-offscreen",
    "sr-only",
    "visually-hidden"
  ]);

  function toHalfWidth(value) {
    return value
      .replace(/[０-９]/g, (char) =>
        String.fromCharCode(char.charCodeAt(0) - 0xfee0)
      )
      .replace(/，/g, ",");
  }

  function parsePriceText(text) {
    const normalized = toHalfWidth(text);
    const digits = normalized.replace(/[^\d]/g, "");
    const amount = Number(digits);

    if (!digits || !Number.isSafeInteger(amount) || amount <= 0) {
      return null;
    }

    return amount;
  }

  function looksLikeNonPrice(text, start, end) {
    const normalized = toHalfWidth(text);
    const after = normalized.slice(end, end + 16).trimStart().toLowerCase();
    const around = normalized.slice(Math.max(0, start - 16), end + 16);

    if (/^(件|人|ポイント|pt|%)/i.test(after)) {
      return true;
    }

    // 価格表示と紛れやすい番号・日付を周辺文脈で除外します。
    return (
      /\b\d{2,4}[-ー−]\d{2,4}[-ー−]\d{3,4}\b/.test(around) ||
      /\b\d{3}[-ー−]\d{4}\b/.test(around) ||
      /\b(?:19|20)\d{2}[\/.\-年]\d{1,2}(?:[\/.\-月]\d{1,2}日?)?\b/.test(
        around
      ) ||
      /\b\d{1,2}[\/.\-月]\d{1,2}日?\b/.test(around)
    );
  }

  function findPricesInText(text, minPrice = DEFAULT_SETTINGS.minPrice) {
    const prices = [];
    let match;

    PRICE_PATTERN.lastIndex = 0;
    while ((match = PRICE_PATTERN.exec(text)) !== null) {
      const [rawText] = match;
      const amount = parsePriceText(rawText);
      const start = match.index;
      const end = start + rawText.length;

      if (
        amount !== null &&
        amount >= minPrice &&
        !looksLikeNonPrice(text, start, end)
      ) {
        prices.push({ text: rawText, amount, start, end });
      }
    }

    return prices;
  }

  function hasHiddenPriceClass(element) {
    return [...element.classList].some((className) =>
      HIDDEN_PRICE_CLASSES.has(className)
    );
  }

  function isAmazonSite() {
    return /(^|\.)amazon\.co\.jp$/.test(location.hostname);
  }

  function shouldSkipElement(element) {
    for (let current = element; current; current = current.parentElement) {
      if (
        current.hasAttribute(JIKA_PROCESSED_ATTR) ||
        current.classList?.contains(JIKA_BADGE_CLASS) ||
        current.isContentEditable ||
        hasHiddenPriceClass(current) ||
        SKIP_TAGS.has(current.tagName)
      ) {
        return true;
      }
    }

    return false;
  }

  function collectTextPriceNodes(root, minPrice = DEFAULT_SETTINGS.minPrice) {
    if (!root) {
      return [];
    }

    if (root.nodeType === Node.TEXT_NODE) {
      if (!root.nodeValue?.trim() || !root.parentElement) {
        return [];
      }

      if (shouldSkipElement(root.parentElement)) {
        return [];
      }

      const prices = findPricesInText(root.nodeValue, minPrice);
      return prices.length > 0 ? [{ node: root, prices }] : [];
    }

    if (
      root.nodeType !== Node.ELEMENT_NODE &&
      root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE
    ) {
      return [];
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue?.trim() || !node.parentElement) {
          return NodeFilter.FILTER_REJECT;
        }

        if (shouldSkipElement(node.parentElement)) {
          return NodeFilter.FILTER_REJECT;
        }

        return findPricesInText(node.nodeValue, minPrice).length > 0
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      }
    });

    const nodes = [];
    let node = walker.nextNode();
    while (node) {
      nodes.push({
        node,
        prices: findPricesInText(node.nodeValue, minPrice)
      });
      node = walker.nextNode();
    }

    return nodes;
  }

  function collectAmazonPriceTargets(
    root = document,
    minPrice = DEFAULT_SETTINGS.minPrice
  ) {
    return [...(root.querySelectorAll?.(AMAZON_CURRENT_PRICE_SELECTOR) || [])]
      .filter(
        (element) =>
          !element.hasAttribute(JIKA_PROCESSED_ATTR) &&
          !shouldSkipElement(element)
      )
      .map((element) => {
        const offscreenText = element
          .querySelector(".a-offscreen")
          ?.textContent?.trim();
        const priceText =
          offscreenText ||
          element.querySelector(".a-price-whole")?.textContent?.trim() ||
          "";
        return { element, amount: parsePriceText(priceText) };
      })
      .filter(
        ({ amount }) => amount !== null && amount >= minPrice
      );
  }

  function normalizeSettings(settings) {
    const hourlyWage = Number(settings.hourlyWage);
    const minPrice = Number(settings.minPrice);

    return {
      enabled: settings.enabled !== false,
      hourlyWage:
        Number.isFinite(hourlyWage) && hourlyWage > 0
          ? Math.round(hourlyWage)
          : DEFAULT_SETTINGS.hourlyWage,
      minPrice:
        Number.isFinite(minPrice) && minPrice >= 0
          ? Math.round(minPrice)
          : DEFAULT_SETTINGS.minPrice,
      disabledDomains: Array.isArray(settings.disabledDomains)
        ? settings.disabledDomains
            .map((domain) => String(domain).toLowerCase())
            .filter(Boolean)
        : []
    };
  }

  function readSettings() {
    if (!globalThis.chrome?.storage?.sync) {
      return Promise.resolve(normalizeSettings(DEFAULT_SETTINGS));
    }

    return new Promise((resolve) => {
      chrome.storage.sync.get(DEFAULT_SETTINGS, (storedSettings) => {
        resolve(normalizeSettings(storedSettings || DEFAULT_SETTINGS));
      });
    });
  }

  function formatNumber(value) {
    return new Intl.NumberFormat("ja-JP").format(value);
  }

  function formatWorkDuration(price, hourlyWage) {
    const hours = price / hourlyWage;

    if (hours < 1) {
      return `${Math.max(1, Math.round(hours * 60))}分`;
    }

    if (hours <= 8) {
      return `${hours.toFixed(1)}時間`;
    }

    if (hours <= 160) {
      return `${(hours / 8).toFixed(1)}日`;
    }

    return `${(hours / 160).toFixed(1)}ヶ月`;
  }

  let currentSettings = normalizeSettings(DEFAULT_SETTINGS);
  let observer = null;
  let debounceTimer = null;
  let pendingRoots = new Set();

  function createBadge(amount) {
    const badge = document.createElement("span");
    badge.className = JIKA_BADGE_CLASS;
    badge.setAttribute(JIKA_PROCESSED_ATTR, "badge");
    badge.textContent = `⏱ ${formatWorkDuration(
      amount,
      currentSettings.hourlyWage
    )}`;
    badge.title = `時給${formatNumber(currentSettings.hourlyWage)}円換算`;
    return badge;
  }

  function renderTextNode({ node, prices }) {
    const fragment = document.createDocumentFragment();
    let cursor = 0;

    for (const price of prices) {
      if (price.start > cursor) {
        fragment.append(document.createTextNode(node.nodeValue.slice(cursor, price.start)));
      }

      const wrapper = document.createElement("span");
      wrapper.className = JIKA_WRAP_CLASS;
      wrapper.setAttribute(JIKA_PROCESSED_ATTR, "text");
      wrapper.dataset.jikaPriceText = price.text;
      wrapper.append(document.createTextNode(price.text), createBadge(price.amount));
      fragment.append(wrapper);
      cursor = price.end;
    }

    if (cursor < node.nodeValue.length) {
      fragment.append(document.createTextNode(node.nodeValue.slice(cursor)));
    }

    node.parentNode.replaceChild(fragment, node);
  }

  function renderTextPrices(root = document.body) {
    for (const item of collectTextPriceNodes(root, currentSettings.minPrice)) {
      if (item.node.parentNode) {
        renderTextNode(item);
      }
    }
  }

  function renderAmazonPrice() {
    for (const { element, amount } of collectAmazonPriceTargets(
      document,
      currentSettings.minPrice
    )) {
      const badge = createBadge(amount);
      element.setAttribute(JIKA_PROCESSED_ATTR, "amazon");
      element.insertAdjacentElement("afterend", badge);
    }
  }

  function renderPricesInRoot(root) {
    renderTextPrices(root);
  }

  function unwrapTextBadges() {
    for (const wrapper of document.querySelectorAll(
      `.${JIKA_WRAP_CLASS}[${JIKA_PROCESSED_ATTR}="text"]`
    )) {
      const priceText =
        wrapper.dataset.jikaPriceText ||
        [...wrapper.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.nodeValue)
          .join("");
      wrapper.replaceWith(document.createTextNode(priceText));
    }
  }

  function clearRenderedBadges() {
    if (isAmazonSite()) {
      for (const price of document.querySelectorAll(
        AMAZON_CURRENT_PRICE_SELECTOR
      )) {
        price.removeAttribute(JIKA_PROCESSED_ATTR);
        if (price.nextElementSibling?.classList.contains(JIKA_BADGE_CLASS)) {
          price.nextElementSibling.remove();
        }
      }
      return;
    }

    unwrapTextBadges();

    for (const badge of document.querySelectorAll(`.${JIKA_BADGE_CLASS}`)) {
      badge.remove();
    }

    for (const element of document.querySelectorAll(
      `[${JIKA_PROCESSED_ATTR}="amazon"]`
    )) {
      element.removeAttribute(JIKA_PROCESSED_ATTR);
    }
  }

  function isDomainDisabled() {
    const host = location.hostname.toLowerCase();
    return currentSettings.disabledDomains.some(
      (domain) => host === domain || host.endsWith(`.${domain}`)
    );
  }

  function shouldRender() {
    return (
      currentSettings.enabled &&
      currentSettings.hourlyWage > 0 &&
      !isDomainDisabled() &&
      Boolean(document.body)
    );
  }

  function disconnectObserver() {
    if (observer) {
      observer.disconnect();
    }
  }

  function hasPotentialPriceSignal(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return PRICE_SIGNAL_PATTERN.test(node.nodeValue || "");
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }

    if (node.childElementCount > 120) {
      return true;
    }

    return PRICE_SIGNAL_PATTERN.test(node.textContent || "");
  }

  function compactPendingRoots(roots) {
    if (roots.some((root) => root === document || root === document.body)) {
      return [document.body];
    }

    const compacted = [];

    for (const root of roots) {
      if (!root?.isConnected) {
        continue;
      }

      const isCovered = compacted.some(
        (existing) => existing === root || existing.contains?.(root)
      );
      if (isCovered) {
        continue;
      }

      for (let index = compacted.length - 1; index >= 0; index -= 1) {
        if (root.contains?.(compacted[index])) {
          compacted.splice(index, 1);
        }
      }

      compacted.push(root);
    }

    return compacted.length > 0 ? compacted : [document.body];
  }

  function queueRootForRender(node) {
    if (!node || node.nodeType === Node.COMMENT_NODE) {
      return;
    }

    const root =
      node.nodeType === Node.TEXT_NODE
        ? node
        : node.nodeType === Node.ELEMENT_NODE ||
            node.nodeType === Node.DOCUMENT_FRAGMENT_NODE
          ? node
          : node.parentElement;

    if (!root?.isConnected) {
      return;
    }

    if (pendingRoots.has(document.body)) {
      return;
    }

    if (pendingRoots.size >= MAX_PENDING_ROOTS) {
      pendingRoots = new Set([document.body]);
      return;
    }

    pendingRoots.add(root);
  }

  function observeMutations() {
    if (!document.body || observer || isAmazonSite()) {
      return;
    }

    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (
          mutation.type === "characterData" &&
          hasPotentialPriceSignal(mutation.target)
        ) {
          queueRootForRender(mutation.target);
          continue;
        }

        for (const node of mutation.addedNodes) {
          if (hasPotentialPriceSignal(node)) {
            queueRootForRender(node);
          }
        }
      }

      if (pendingRoots.size > 0) {
        scheduleIncrementalRender();
      }
    });

    observer.observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true
    });
  }

  function renderPendingPrices() {
    clearTimeout(debounceTimer);
    debounceTimer = null;

    if (!shouldRender()) {
      pendingRoots.clear();
      return;
    }

    const roots = compactPendingRoots([...pendingRoots]);
    pendingRoots.clear();
    disconnectObserver();
    for (const root of roots) {
      renderPricesInRoot(root);
    }
    observer = null;
    observeMutations();
  }

  function scheduleIncrementalRender() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(renderPendingPrices, MUTATION_DEBOUNCE_MS);
  }

  function renderAllPrices() {
    if (isAmazonSite()) {
      if (shouldRender()) {
        renderAmazonPrice();
      }
      return;
    }

    pendingRoots = new Set([document.body]);
    renderPendingPrices();
  }

  function refreshAllBadges() {
    clearTimeout(debounceTimer);
    disconnectObserver();
    observer = null;
    pendingRoots.clear();
    clearRenderedBadges();
    renderAllPrices();
  }

  function watchSettings() {
    if (!globalThis.chrome?.storage?.onChanged) {
      return;
    }

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "sync") {
        return;
      }

      const nextSettings = { ...currentSettings };
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (Object.hasOwn(changes, key)) {
          nextSettings[key] = changes[key].newValue;
        }
      }
      currentSettings = normalizeSettings(nextSettings);
      refreshAllBadges();
    });
  }

  function init() {
    readSettings().then((settings) => {
      currentSettings = settings;
      refreshAllBadges();
      watchSettings();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

  window.__jikaDebug = {
    badgeClass: JIKA_BADGE_CLASS,
    collectAmazonPriceTargets,
    collectTextPriceNodes,
    findPricesInText,
    formatWorkDuration,
    parsePriceText,
    refreshAllBadges
  };
})();
