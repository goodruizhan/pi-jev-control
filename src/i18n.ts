import { loadConfig } from "./config.js";
import type { JevControlConfig } from "./types.js";

export type Language = JevControlConfig["language"];

export function isChinese(language: string | undefined): boolean {
  return language?.toLowerCase() === "zh-cn" || language?.toLowerCase() === "zh";
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
