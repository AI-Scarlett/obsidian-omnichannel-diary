"use strict";

const LANGUAGE_PREFERENCES = ["auto", "zh-CN", "en"];

function normalizeLanguagePreference(value) {
  const normalized = String(value || "auto").trim();
  if (normalized === "zh" || normalized.toLowerCase() === "zh-cn") return "zh-CN";
  if (normalized.toLowerCase().startsWith("en")) return "en";
  return LANGUAGE_PREFERENCES.includes(normalized) ? normalized : "auto";
}

function resolveLocale(preference = "auto", detected = "") {
  const selected = normalizeLanguagePreference(preference);
  if (selected !== "auto") return selected;
  return String(detected || "").toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

function detectAppLocale(app) {
  const candidates = [
    app?.vault?.getConfig?.("locale"),
    globalThis.moment?.locale?.(),
    typeof document !== "undefined" ? document.documentElement?.lang : "",
    typeof navigator !== "undefined" ? navigator.language : "",
  ];
  return candidates.find((value) => String(value || "").trim()) || "en";
}

function appLocale(app, preference = "auto") {
  return resolveLocale(preference, detectAppLocale(app));
}

function interpolate(template, values = {}) {
  return String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
  ));
}

function translate(locale, zh, en, values = {}) {
  return interpolate(locale === "en" ? en : zh, values);
}

module.exports = {
  LANGUAGE_PREFERENCES,
  appLocale,
  detectAppLocale,
  interpolate,
  normalizeLanguagePreference,
  resolveLocale,
  translate,
};
