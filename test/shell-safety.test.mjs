import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyShellCommand,
  isDangerousBashCommand,
  isSafeBashCommand,
  setupToolGate,
} from "../dist/src/gates/tool-gate.js";
import { loadConfig } from "../dist/src/config.js";
import { extractCommand } from "../dist/src/gates/tool-gate.js";
import { resetJudgeBackends as resetClient } from "../dist/src/judge/registry.js";

// ── P1-1: wrapper / obfuscation bypasses ───────────────────────────────
// Every one of these must classify as "dangerous". Before the wrapper-aware
// splitter these all returned "uncertain" and therefore passed the enforce gate.

test("shell wrappers expose their payload to the dangerous check", () => {
  const cases = [
    "sh -c 'rm -rf /'",
    'bash -c "rm -rf /"',
    "bash -lc 'rm -rf /'",
    "zsh -c 'rm -rf /'",
    "dash -c 'rm -rf /'",
    "bash --noprofile --norc -c 'rm -rf /'",
    "sh -c $'rm -rf /'",
    "rm$IFS-rf$IFS/",
    "rm -rf${IFS}/",
    "cmd /c rm -rf C:\\",
    'powershell -Command "rm -rf C:\\data"',
    "powershell -ExecutionPolicy Bypass -Command 'rm -rf C:\\data'",
    "powershell -C \"rm -rf C:\\data\"",
  ];
  for (const command of cases) {
    assert.equal(isDangerousBashCommand(command), true, `should be dangerous: ${command}`);
    assert.equal(classifyShellCommand(command), "dangerous", `should be dangerous: ${command}`);
  }
});

test("bash builtins that run their argument are not a bypass", () => {
  for (const command of [
    "exec rm -rf /",
    "command rm -rf /",
    'eval "rm -rf /"',
    "nice -n 10 rm -rf /",
    "nohup rm -rf /",
    "timeout 5s rm -rf /",
  ]) {
    assert.equal(classifyShellCommand(command), "dangerous", `should be dangerous: ${command}`);
  }
});

test("interpreter one-liners that shell out are caught", () => {
  const cases = [
    'python3 -c "import os; os.system(\'rm -rf /\')"',
    "python -c \"import os; os.system('rm -rf /')\"",
    "python3 -c \"import shutil; shutil.rmtree('/')\"",
    "python3 -c \"import subprocess; subprocess.run('rm -rf /', shell=True)\"",
    'node -e "require(\'child_process\').exec(\'rm -rf /\')"',
    'node --eval "require(\'fs\').rmSync(\'/data\', { recursive: true, force: true })"',
    "perl -e 'system(\"rm -rf /\")'",
    'awk \'BEGIN{system("rm -rf /")}\'',
    'awk \'BEGIN{popen("rm -rf /","w")}\'',
    "sh -c \"bash -c 'rm -rf /'\"",
    "sh -c 'echo hi; rm -rf /'",
    "sh -c 'echo hi && rm -rf /'",
  ];
  for (const command of cases) {
    assert.equal(classifyShellCommand(command), "dangerous", `should be dangerous: ${command}`);
  }
});

// ── P1-2: missing team-level destructive commands ───────────────────────

test("history-rewriting and force-pushing git commands are dangerous", () => {
  for (const command of [
    "git push --force origin main",
    "git push -f origin main",
    "git push origin main --force",
    "git push origin main --force -u",
    "git filter-branch --all",
    "git filter-repo --path secret.txt",
    "git branch -D feature-x",
  ]) {
    assert.equal(classifyShellCommand(command), "dangerous", `should be dangerous: ${command}`);
  }
});

test("auto-approval, cluster and container teardown are dangerous", () => {
  for (const command of [
    "npx --yes some-script",
    "npx -y some-script",
    "npm exec --yes foo",
    "npm dlx --yes foo",
    "pnpm dlx --yes foo",
    "yarn dlx --yes foo",
    "kubectl delete pod foo",
    "kubectl delete namespace prod",
    "docker rm -f container1",
    "docker volume rm data",
    "docker system prune -af",
    "podman rm -f container1",
  ]) {
    assert.equal(classifyShellCommand(command), "dangerous", `should be dangerous: ${command}`);
  }
});

test("SQL teardown, recursive metadata and disk writes are dangerous", () => {
  for (const command of [
    "DROP TABLE users",
    "drop table users",
    "DROP DATABASE prod",
    "TRUNCATE TABLE users",
    "chmod -R 777 /etc",
    "chmod -R a+rwx .",
    "chmod -Rf 600 /data",
    "chown -R root /data",
    "dd if=/dev/zero of=/dev/sda",
    "dd of=/dev/nvme0n1 if=/dev/zero",
    "mkfs.ext4 /dev/sda1",
    "fdisk /dev/sda",
    "sgdisk --zap-all /dev/sda",
  ]) {
    assert.equal(classifyShellCommand(command), "dangerous", `should be dangerous: ${command}`);
  }
});

// ── False-positive guard: things that contain destructive-looking text but
// are harmless must NOT be flagged. These are the regressions the wrapper
// expansion can easily introduce.

test("harmless commands are not flagged by the wrapper expansion", () => {
  for (const command of [
    'echo "hello; rm -rf /"',
    'echo \'rm -rf / is dangerous\'',
    "echo rm -rf /",
    "grep -r \"rm -rf\" src/",
    'printf "%s" "rm -rf /"',
    "git push --follow-tags origin main",
    "git push origin main",
    "git push -u origin main",
    "command -v foo",
    "eval x",
    "exec 3<&0",
    "python3 script.py",
    "python3 -m pip install requests",
    "node -e 'console.log(1)'",
    "npx some-script",
    "npx --help",
    "rm foo.txt",
    "chmod 755 file.sh",
    "chmod 644 file.txt",
    "cat README.md",
    "bash -c 'git status'",
    "sh -c 'ls -la'",
    'awk \'{print $1}\' file.txt',
    "timeout 5s sleep 100",
    "echo \"Drop Table never\" | cat",
  ]) {
    assert.notEqual(
      classifyShellCommand(command),
      "dangerous",
      `must NOT be dangerous: ${command}`,
    );
  }
});

test("safe prefix classification is unchanged", () => {
  assert.equal(classifyShellCommand("git status --short"), "safe");
  assert.equal(classifyShellCommand("ls -la"), "safe");
  assert.equal(classifyShellCommand("pwd"), "safe");
  assert.equal(classifyShellCommand("git status && rm -rf ./victim"), "dangerous");
  assert.equal(classifyShellCommand("find . -delete"), "dangerous");
  assert.equal(classifyShellCommand("npm install left-pad"), "uncertain");
  assert.equal(isSafeBashCommand("git status"), true);
  assert.equal(isSafeBashCommand("rm -rf /tmp/x"), false);
});

// ── P2 G-1 / G-2: tool-name casing and command field aliases ────────────

test("extractCommand reads the command under every known field name", () => {
  assert.equal(extractCommand({ command: "rm -rf /" }), "rm -rf /");
  assert.equal(extractCommand({ cmd: "rm -rf /" }), "rm -rf /");
  assert.equal(extractCommand({ shell: "rm -rf /" }), "rm -rf /");
  assert.equal(extractCommand({ script: "rm -rf /" }), "rm -rf /");
  assert.equal(extractCommand({ args: { command: "rm -rf /" } }), "rm -rf /");
  assert.equal(extractCommand({}), "");
  assert.equal(extractCommand({ command: 42 }), "");
  assert.equal(extractCommand({ command: "  ", cmd: "ls" }), "ls");
});

function createToolGateHarness() {
  const handlers = new Map();
  setupToolGate({ on: (event, handler) => handlers.set(event, handler) });
  return handlers.get("tool_call");
}

function enforceCtx(confirmAnswer = false) {
  let confirmations = 0;
  return {
    confirmations: () => confirmations,
    ctx: {
      signal: undefined,
      ui: {
        confirm: async () => { confirmations += 1; return confirmAnswer; },
        notify() {},
      },
    },
  };
}

test("tool name casing does not bypass shell classification", async () => {
  const originalKey = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  resetClient();

  const handler = createToolGateHarness();
  const config = loadConfig();
  config.enabled = true;
  config.toolGate.enabled = true;
  config.toolGate.mode = "enforce";
  config.retryJudge.enabled = false;
  const { ctx, confirmations } = enforceCtx();

  // Any casing of the tool name must reach the shell classifier.
  for (const toolName of ["BASH", "Bash", "bash", "POWERSHELL", "Powershell", "pwsh", "sh"]) {
    const result = await handler({ toolName, input: { command: "rm -rf /" } }, ctx);
    assert.equal(result?.block, true, `${toolName} must be blocked`);
  }
  assert.equal(confirmations(), 7);

  if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = originalKey;
  resetClient();
});

test("command field aliases are classified, not silently let through", async () => {
  const originalKey = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  resetClient();

  const handler = createToolGateHarness();
  const config = loadConfig();
  config.enabled = true;
  config.toolGate.enabled = true;
  config.toolGate.mode = "enforce";
  config.retryJudge.enabled = false;
  const { ctx, confirmations } = enforceCtx();

  for (const input of [
    { cmd: "rm -rf /" },
    { shell: "rm -rf /" },
    { script: "rm -rf /" },
    { args: { command: "rm -rf /" } },
    { command: "sh -c 'rm -rf /'" },
  ]) {
    const result = await handler({ toolName: "bash", input }, ctx);
    assert.equal(result?.block, true, `${JSON.stringify(input)} must be blocked`);
  }
  assert.equal(confirmations(), 5);

  // A wrapper command spelled under an alias is caught too.
  const wrapped = await handler({ toolName: "bash", input: { cmd: "python3 -c \"import shutil; shutil.rmtree('/')\"" } }, ctx);
  assert.equal(wrapped?.block, true);

  if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = originalKey;
  resetClient();
});

test("enforce mode blocks wrapper bypasses end to end", async () => {
  const originalKey = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  resetClient();

  const handler = createToolGateHarness();
  const config = loadConfig();
  config.enabled = true;
  config.toolGate.enabled = true;
  config.toolGate.mode = "enforce";
  config.retryJudge.enabled = false;
  const { ctx, confirmations } = enforceCtx();

  // These are the exact cases that used to pass the enforce gate.
  for (const command of [
    "sh -c 'rm -rf /'",
    'bash -c "rm -rf /"',
    "exec rm -rf /",
    "rm$IFS-rf$IFS/",
    "cmd /c rm -rf C:\\",
    "python3 -c \"import shutil; shutil.rmtree('/')\"",
    'awk \'BEGIN{system("rm -rf /")}\'',
    "git push --force origin main",
    "npx --yes some-script",
    "kubectl delete pod foo",
  ]) {
    const result = await handler({ toolName: "bash", input: { command } }, ctx);
    assert.equal(result?.block, true, `${command} must be blocked`);
  }
  assert.equal(confirmations(), 10);

  if (originalKey === undefined) delete process.env.TYPESSAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = originalKey;
  resetClient();
});

test("advisory mode warns on wrapper bypasses without blocking", async () => {
  const originalKey = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  resetClient();

  const handler = createToolGateHarness();
  const config = loadConfig();
  config.enabled = true;
  config.toolGate.enabled = true;
  config.toolGate.mode = "advisory";
  config.retryJudge.enabled = false;
  const { ctx, confirmations } = enforceCtx();

  const result = await handler({ toolName: "bash", input: { command: "sh -c 'rm -rf /'" } }, ctx);
  assert.equal(result, undefined, "advisory never blocks");
  assert.equal(confirmations(), 0, "advisory never confirms");

  if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = originalKey;
  resetClient();
});
