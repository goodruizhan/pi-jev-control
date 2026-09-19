import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";

export function notifyAutomatic(
  ctx: Pick<ExtensionContext, "ui">,
  message: string,
  level: "info" | "warning" | "error",
): void {
  const mode = loadConfig().ui.notifications;
  if (mode === "errors-only" && level !== "error") return;
  if (mode === "important" && level === "info") return;
  ctx.ui.notify(message, level);
}
