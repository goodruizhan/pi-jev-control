import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { MemoryRecord } from "../types.js";

/**
 * Memory Store — local JSONL persistence for memory records.
 * 
 * Storage path: ~/.pi/agent/jev-control-data/projects/<project-hash>/
 * Files: memory.jsonl, failures.jsonl
 * 
 * project-hash = sha256(normalized cwd) — avoids modifying UE project repos.
 */

const BASE_DIR = path.join(os.homedir(), ".pi", "agent", "jev-control-data");

/**
 * Compute project hash from cwd.
 */
export function getProjectHash(cwd: string = process.cwd()): string {
  // Normalize: lowercase, remove trailing slashes, collapse paths
  const normalized = cwd.toLowerCase().replace(/[\\/]+$/, "");
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * Get the project-specific data directory.
 */
export function getProjectDir(cwd?: string): string {
  return path.join(BASE_DIR, "projects", getProjectHash(cwd));
}

/**
 * Ensure the project directory exists.
 */
function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Append a memory record to memory.jsonl.
 */
export function appendMemory(record: MemoryRecord): void {
  const dir = getProjectDir();
  ensureDir(dir);
  const filePath = path.join(dir, "memory.jsonl");
  const line = JSON.stringify(record) + "\n";
  fs.appendFileSync(filePath, line, "utf-8");
}

/**
 * Append a failure record to failures.jsonl.
 */
export function appendFailure(record: MemoryRecord): void {
  const dir = getProjectDir();
  ensureDir(dir);
  const filePath = path.join(dir, "failures.jsonl");
  const line = JSON.stringify(record) + "\n";
  fs.appendFileSync(filePath, line, "utf-8");
}

/** Insert a new failure or update the existing unresolved record with the same action. */
export function upsertFailure(record: MemoryRecord): boolean {
  const dir = getProjectDir();
  ensureDir(dir);
  const filePath = path.join(dir, "failures.jsonl");
  const records = readJsonl<MemoryRecord>(filePath);
  const existing = records.find((item) => item.type === "failure" && !item.resolved && item.fingerprint === record.fingerprint);

  if (existing) {
    existing.timestamp = record.timestamp;
    existing.summary = record.summary;
    existing.rawExcerpt = record.rawExcerpt;
    existing.result = record.result;
    existing.reason = record.reason;
    existing.retryCount = (existing.retryCount ?? 1) + 1;
    existing.confidence = record.confidence;
    fs.writeFileSync(filePath, records.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf-8");
    return false;
  }

  fs.appendFileSync(filePath, JSON.stringify(record) + "\n", "utf-8");
  return true;
}

/**
 * Read all memory records from memory.jsonl.
 */
export function readAllMemory(cwd?: string): MemoryRecord[] {
  const dir = getProjectDir(cwd);
  const filePath = path.join(dir, "memory.jsonl");
  return readJsonl<MemoryRecord>(filePath);
}

/**
 * Read all failure records from failures.jsonl.
 */
export function readAllFailures(cwd?: string): MemoryRecord[] {
  const dir = getProjectDir(cwd);
  const filePath = path.join(dir, "failures.jsonl");
  return readJsonl<MemoryRecord>(filePath);
}

/**
 * Read and parse a JSONL file.
 */
function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    const results: T[] = [];
    for (const line of lines) {
      try {
        results.push(JSON.parse(line) as T);
      } catch {
        // Skip invalid lines
      }
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Mark a failure as resolved.
 */
export function markFailureResolved(id: string): boolean {
  const dir = getProjectDir();
  const filePath = path.join(dir, "failures.jsonl");
  if (!fs.existsSync(filePath)) return false;

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    let found = false;
    const updatedLines = lines.map((line) => {
      try {
        const record = JSON.parse(line) as MemoryRecord;
        if (record.id === id) {
          record.resolved = true;
          found = true;
          return JSON.stringify(record);
        }
        return line;
      } catch {
        return line;
      }
    });
    fs.writeFileSync(filePath, updatedLines.join("\n") + "\n", "utf-8");
    return found;
  } catch {
    return false;
  }
}

/**
 * Clear all memory records for a project.
 */
export function clearAllMemory(cwd?: string): void {
  const dir = getProjectDir(cwd);
  const memPath = path.join(dir, "memory.jsonl");
  const failPath = path.join(dir, "failures.jsonl");
  if (fs.existsSync(memPath)) fs.unlinkSync(memPath);
  if (fs.existsSync(failPath)) fs.unlinkSync(failPath);
}

/**
 * Get count of memory records.
 */
export function getMemoryCount(cwd?: string): { memory: number; failures: number } {
  const dir = getProjectDir(cwd);
  const memPath = path.join(dir, "memory.jsonl");
  const failPath = path.join(dir, "failures.jsonl");

  const countLines = (p: string): number => {
    if (!fs.existsSync(p)) return 0;
    try {
      return fs.readFileSync(p, "utf-8").split("\n").filter((l) => l.trim()).length;
    } catch {
      return 0;
    }
  };

  return {
    memory: countLines(memPath),
    failures: countLines(failPath),
  };
}

/**
 * Get the data directory path for display.
 */
export function getDataPath(cwd?: string): string {
  return getProjectDir(cwd);
}
