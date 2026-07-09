(() => {
  "use strict";

  const DEFAULT_SETTINGS = {
    enabled: true,
    hourlyWage: 1500,
    minPrice: 500,
    monthlyIncome: "",
    monthlyHours: 160,
    netIncome: false,
    disabledDomains: []
  };
  const NET_INCOME_RATE = 0.8;
  const SAVE_DELAY = 180;

  const elements = {
    enabled: document.getElementById("enabled"),
    hourlyWage: document.getElementById("hourlyWage"),
    minPrice: document.getElementById("minPrice"),
    monthlyIncome: document.getElementById("monthlyIncome"),
    monthlyHours: document.getElementById("monthlyHours"),
    netIncome: document.getElementById("netIncome"),
    disableSite: document.getElementById("disableSite"),
    status: document.getElementById("status")
  };

  let currentSettings = { ...DEFAULT_SETTINGS };
  let currentHost = "";
  let pendingPatch = {};
  let saveTimer = null;
  let statusTimer = null;

  function normalizeSettings(settings) {
    return {
      ...DEFAULT_SETTINGS,
      ...settings,
      enabled: settings.enabled !== false,
      hourlyWage: readPositiveNumber(settings.hourlyWage, DEFAULT_SETTINGS.hourlyWage),
      minPrice: readNonNegativeNumber(settings.minPrice, DEFAULT_SETTINGS.minPrice),
      monthlyIncome:
        settings.monthlyIncome === "" ? "" : readNonNegativeNumber(settings.monthlyIncome, ""),
      monthlyHours: readPositiveNumber(
        settings.monthlyHours,
        DEFAULT_SETTINGS.monthlyHours
      ),
      netIncome: Boolean(settings.netIncome),
      disabledDomains: Array.isArray(settings.disabledDomains)
        ? settings.disabledDomains
            .map((domain) => String(domain).toLowerCase())
            .filter(Boolean)
        : []
    };
  }

  function readPositiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
  }

  function readNonNegativeNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.round(number) : fallback;
  }

  function readInputNumber(input) {
    if (input.value.trim() === "") {
      return null;
    }

    const value = Number(input.value);
    return Number.isFinite(value) ? value : null;
  }

  function setStatus(message, persistent = false) {
    clearTimeout(statusTimer);
    elements.status.textContent = message;

    if (!persistent && message) {
      statusTimer = setTimeout(() => {
        elements.status.textContent = "";
      }, 2400);
    }
  }

  function storageGet(defaults) {
    return new Promise((resolve) => {
      chrome.storage.sync.get(defaults, (storedSettings) => {
        resolve(storedSettings || defaults);
      });
    });
  }

  function storageSet(patch) {
    return new Promise((resolve, reject) => {
      chrome.storage.sync.set(patch, () => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  function queueSave(patch, message = "保存しました") {
    pendingPatch = { ...pendingPatch, ...patch };
    currentSettings = normalizeSettings({ ...currentSettings, ...patch });
    clearTimeout(saveTimer);

    saveTimer = setTimeout(() => {
      const patchToSave = { ...pendingPatch };
      pendingPatch = {};
      saveSettings(patchToSave, message);
    }, SAVE_DELAY);
  }

  function saveSettings(patch, message = "保存しました") {
    currentSettings = normalizeSettings({ ...currentSettings, ...patch });

    storageSet(patch)
      .then(() => {
        setStatus(message);
        updateDisableSiteButton();
      })
      .catch(() => {
        setStatus("保存に失敗しました", true);
      });
  }

  function fillForm(settings) {
    elements.enabled.checked = settings.enabled;
    elements.hourlyWage.value = String(settings.hourlyWage);
    elements.minPrice.value = String(settings.minPrice);
    elements.monthlyIncome.value =
      settings.monthlyIncome === "" ? "" : String(settings.monthlyIncome);
    elements.monthlyHours.value = String(settings.monthlyHours);
    elements.netIncome.checked = settings.netIncome;
  }

  function calculateHourlyFromMonthly() {
    const monthlyIncome = readInputNumber(elements.monthlyIncome);
    const monthlyHours = readInputNumber(elements.monthlyHours);
    const netIncome = elements.netIncome.checked;

    if (monthlyIncome === null || monthlyIncome < 0) {
      setStatus("月収を入力してください");
      return;
    }

    if (monthlyHours === null || monthlyHours <= 0) {
      setStatus("月間労働時間を入力してください");
      return;
    }

    const effectiveIncome = netIncome ? monthlyIncome * NET_INCOME_RATE : monthlyIncome;
    const hourlyWage = Math.max(1, Math.round(effectiveIncome / monthlyHours));
    elements.hourlyWage.value = String(hourlyWage);

    queueSave(
      {
        hourlyWage,
        monthlyIncome: Math.round(monthlyIncome),
        monthlyHours: Math.round(monthlyHours),
        netIncome
      },
      "月収から時給を更新しました"
    );
  }

  function updateDirectHourlyWage() {
    const hourlyWage = readInputNumber(elements.hourlyWage);

    if (hourlyWage === null || hourlyWage <= 0) {
      setStatus("時給を入力してください");
      return;
    }

    queueSave({ hourlyWage: Math.round(hourlyWage) });
  }

  function updateMinPrice() {
    const minPrice = readInputNumber(elements.minPrice);

    if (minPrice === null || minPrice < 0) {
      setStatus("最低表示金額を入力してください");
      return;
    }

    queueSave({ minPrice: Math.round(minPrice) });
  }

  function getCurrentHost() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
        try {
          resolve(tab?.url ? new URL(tab.url).hostname.toLowerCase() : "");
        } catch {
          resolve("");
        }
      });
    });
  }

  function updateDisableSiteButton() {
    if (!currentHost) {
      elements.disableSite.disabled = true;
      elements.disableSite.textContent = "このサイトでは無効";
      return;
    }

    const disabled = currentSettings.disabledDomains.includes(currentHost);
    elements.disableSite.disabled = disabled;
    elements.disableSite.textContent = disabled
      ? "このサイトは無効済み"
      : "このサイトでは無効";
  }

  function disableCurrentSite() {
    if (!currentHost) {
      setStatus("このページでは使えません");
      return;
    }

    const disabledDomains = Array.from(
      new Set([...currentSettings.disabledDomains, currentHost])
    );
    saveSettings(
      { disabledDomains },
      `${currentHost} を無効にしました`
    );
  }

  function bindEvents() {
    elements.enabled.addEventListener("change", () => {
      saveSettings({ enabled: elements.enabled.checked });
    });
    elements.hourlyWage.addEventListener("input", updateDirectHourlyWage);
    elements.minPrice.addEventListener("input", updateMinPrice);
    elements.monthlyIncome.addEventListener("input", calculateHourlyFromMonthly);
    elements.monthlyHours.addEventListener("input", calculateHourlyFromMonthly);
    elements.netIncome.addEventListener("change", calculateHourlyFromMonthly);
    elements.disableSite.addEventListener("click", disableCurrentSite);
  }

  function init() {
    storageGet(DEFAULT_SETTINGS)
      .then((settings) => {
        currentSettings = normalizeSettings(settings);
        fillForm(currentSettings);
        return getCurrentHost();
      })
      .then((host) => {
        currentHost = host;
        updateDisableSiteButton();
        bindEvents();
      })
      .catch(() => {
        setStatus("設定の読み込みに失敗しました", true);
      });
  }

  init();
})();
