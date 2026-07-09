(() => {
  "use strict";

  const JIKA_BADGE_CLASS = "jika-badge";
  const JIKA_PROCESSED_ATTR = "data-jika-processed";
  const DEFAULT_SETTINGS = {
    enabled: true,
    hourlyWage: 1500,
    minPrice: 500,
    disabledDomains: []
  };
  const PRICE_PATTERN =
    /([¥￥]\s*(?:[0-9０-９]{1,3}(?:[,，][0-9０-９]{3})+|[0-9０-９]+)|(?:[0-9０-９]{1,3}(?:[,，][0-9０-９]{3})+|[0-9０-９]+)\s*円)/g;
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

  function collectAmazonPriceTargets(minPrice = DEFAULT_SETTINGS.minPrice) {
    const candidates = new Set(
      [...document.querySelectorAll(".a-price, .a-price-whole")]
        .map((element) => element.closest(".a-price") || element)
        .filter(Boolean)
    );

    return [...candidates]
      .filter(
        (element) =>
          !element.hasAttribute(JIKA_PROCESSED_ATTR) &&
          !shouldSkipElement(element)
      )
      .map((element) => {
        const offscreen = element.querySelector(".a-offscreen");
        const whole = element.querySelector(".a-price-whole");
        const amount = parsePriceText(
          offscreen?.textContent || whole?.textContent || element.textContent
        );
        return { element, amount };
      })
      .filter(({ amount }) => amount !== null && amount >= minPrice);
  }

  window.__jikaDebug = {
    badgeClass: JIKA_BADGE_CLASS,
    collectAmazonPriceTargets,
    collectTextPriceNodes,
    findPricesInText,
    parsePriceText
  };
})();
