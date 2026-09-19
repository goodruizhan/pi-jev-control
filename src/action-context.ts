import path from "node:path";

const WRITE_LIKE_TOOLS = new Set(["write", "edit", "apply_patch", "create_file", "update_file"]);

export function isWriteLikeTool(toolName: string): boolean {
  return WRITE_LIKE_TOOLS.has(toolName.toLowerCase());
}

export function getInputPath(input: Record<string, unknown>): string | null {
  for (const key of ["path", "file_path", "filePath", "target", "targetPath"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** Stable session key. File contents are intentionally excluded for repeated writes. */
export function getActionKey(toolName: string, input: Record<string, unknown>): string {
  const normalizedTool = toolName.toLowerCase().trim();
  const inputPath = getInputPath(input);
  if (inputPath) {
    return `${normalizedTool}|path:${path.resolve(inputPath).toLowerCase()}`;
  }

  const command = typeof input.command === "string" ? normalize(input.command).slice(0, 500) : "";
  if (command) return `${normalizedTool}|command:${command}`;
  return `${normalizedTool}|input:${normalize(JSON.stringify(input)).slice(0, 500)}`;
}

export function getCommandCategory(toolName: string, input: Record<string, unknown>): string {
  const normalizedTool = toolName.toLowerCase().trim();
  if (normalizedTool !== "bash" && normalizedTool !== "powershell") return normalizedTool;

  const command = typeof input.command === "string" ? input.command.trim() : "";
  const match = command.match(/^(?:[\w-]+\s*=\S+\s+)*([\w.\\/-]+)(?:\s+([\w:-]+))?/i);
  if (!match) return `${normalizedTool}:unknown`;
  const executable = match[1].replace(/^.*[\\/]/, "").toLowerCase();
  const subcommand = (match[2] ?? "").toLowerCase();
  const compound = ["git", "npm", "pnpm", "yarn", "cargo", "dotnet"].includes(executable) && subcommand
    ? `${executable} ${subcommand}`
    : executable;
  return `${normalizedTool}:${compound}`;
}

export function getUncertainField(toolName: string, input: Record<string, unknown>): string {
  const inputPath = getInputPath(input);
  if (inputPath) return `path=${inputPath}`;
  if (typeof input.command === "string") return `command=${input.command.slice(0, 200)}`;
  return `tool=${toolName}`;
}

function normalize(value: string): string {
  return value.toLowerCase().trim().replace(/\s+/g, " ");
}
