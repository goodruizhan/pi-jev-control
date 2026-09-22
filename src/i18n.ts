import { loadConfig } from "./config.js";
import type { JevControlConfig } from "./types.js";

export type Language = JevControlConfig["language"];

/** True for every alias normalizeLanguage() accepts, so a config file that says
 * "cn" or "chinese" cannot silently fall back to English. */
export function isChinese(language: string | undefined): boolean {
  return normalizeLanguage(language) === "zh-CN";
}

export function normalizeLanguage(language: string | undefined): Language | null {
  const value = language?.trim().toLowerCase();
  if (value === "en" || value === "english") return "en";
  if (value === "zh" || value === "zh-cn" || value === "cn" || value === "chinese") return "zh-CN";
  return null;
}

export function trFor(language: string | undefined, english: string, chinese: string): string {
  return isChinese(language) ? chinese : english;
}

export function tr(english: string, chinese: string): string {
  return trFor(loadConfig().language, english, chinese);
}

export function onOff(enabled: boolean, language: string | undefined = loadConfig().language): string {
  return trFor(language, enabled ? "ON" : "OFF", enabled ? "开启" : "关闭");
}
