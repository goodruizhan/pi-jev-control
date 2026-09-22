import type { TaskTier } from "../types.js";

export interface RouteRisk {
  minimumTier: "cheap" | "medium" | "strong";
  features: string[];
  filePaths: string[];
}

const STRONG_RULES: Array<[string, RegExp]> = [
  ["engine-internals", /\b(?:GAS|GameplayAbility|Garbage Collection|GC|multithread(?:ing|ed)?|thread safety|race condition|replication|RepNotify|RPC|RenderCore|Build\.cs)\b|垃圾回收|多线程|线程安全|网络复制|引擎底层|跨模块|架构设计/i],
  ["high-impact", /(?:large.scale|high.impact|breaking change|data migration|mass (?:rename|delete|move)|architecture refactor)|大规模|高影响|数据迁移|批量(?:删除|重命名|移动)|架构(?:重构|设计)/i],
  ["deep-review", /(?:root cause|crash analysis|final (?:audit|review)|thorough(?:ly)? analy[sz]e)|根因分析|崩溃根因|仔细分析|最终审查|不要省略/i],
];

const MEDIUM_RULES: Array<[string, RegExp]> = [
  ["code-or-assets", /\b(?:C\+\+|\.cpp|\.h\b|Blueprint|UMG|DataTable|Niagara|asset(?:s)?|\.uasset)\b|蓝图|资产|控件蓝图|粒子系统/i],
  ["verification", /\b(?:build|compile|test|PIE|automation|integration test)\b|编译|构建|测试|自动化验证|运行验证/i],
  ["mutating-operation", /\b(?:delete|remove|rename|move|refactor|rewrite|migrate)\b|删除|重命名|移动|重构|迁移|批量修改/i],
  ["multi-file", /\b(?:multiple files|multi.file|several files|across files)\b|多文件|多个文件|多处修改/i],
  ["full-delivery", /(?:complete implementation|end.to.end|ship|deliver)|完整实现|全流程|交付/i],
];

const PATH_RE = /(?:[\w.-]+[\\/])+[\w.-]+\.[a-zA-Z0-9]+|[\w.-]+\.(?:cpp|hpp|h|ts|tsx|js|jsx|py|cs|uasset|uproject|Build\.cs)/g;

export function extractRouteRisk(text: string): RouteRisk {
  const features: string[] = [];
  let minimumTier: RouteRisk["minimumTier"] = "cheap";
  for (const [name, pattern] of MEDIUM_RULES) {
    if (pattern.test(text)) {
      features.push(name);
      minimumTier = "medium";
    }
  }
  for (const [name, pattern] of STRONG_RULES) {
    if (pattern.test(text)) {
      features.push(name);
      minimumTier = "strong";
    }
  }
  const filePaths = [...new Set(text.match(PATH_RE) ?? [])].slice(0, 20);
  if (filePaths.length > 1) {
    features.push("multiple-paths");
    if (minimumTier === "cheap") minimumTier = "medium";
  }
  return { minimumTier, features, filePaths };
}

export function tierAtLeast(tier: TaskTier, floor: RouteRisk["minimumTier"]): TaskTier {
  const rank: Record<TaskTier, number> = { unknown: 0, cheap: 1, medium: 2, strong: 3 };
  return rank[tier] >= rank[floor] ? tier : floor;
}

/** Preserve both the task opening and final constraints on long inputs. */
export function summarizeTask(text: string, maxChars = 4000): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const head = Math.floor(maxChars * 0.55);
  return `${trimmed.slice(0, head)}\n[... ${trimmed.length - maxChars} characters omitted ...]\n${trimmed.slice(-(maxChars - head))}`;
}
