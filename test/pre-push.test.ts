import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolatedGitEnv } from "./support/git-env.ts";

const HOOK = fileURLToPath(new URL("../.githooks/pre-push", import.meta.url));
const ZERO = "0".repeat(40);

// Stands in for gitleaks: records each call and exits with FAKE_EXIT.
const FAKE_GITLEAKS = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_LOG"
exit "\${FAKE_EXIT:-0}"
`;

describe("pre-push hook", () => {
  let root: string;
  let repo: string;
  let log: string;

  function git(...args: string[]): string {
    const result = spawnSync("git", args, {
      cwd: repo,
      env: isolatedGitEnv(),
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  }

  function commit(name: string): string {
    writeFileSync(join(repo, name), name);
    git("add", name);
    git("commit", "-q", "-m", name);
    return git("rev-parse", "HEAD");
  }

  function push(lines: string[], exitCode = 0) {
    return spawnSync("sh", [HOOK, "origin", "unused-url"], {
      cwd: repo,
      env: {
        ...isolatedGitEnv(),
        FAKE_LOG: log,
        FAKE_EXIT: String(exitCode),
      },
      input: lines.map((line) => `${line}\n`).join(""),
      encoding: "utf8",
    });
  }

  function scans(): string[] {
    return existsSync(log)
      ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
      : [];
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pre-push-"));
    repo = join(root, "repo");
    log = join(root, "scans.log");
    mkdirSync(join(repo, ".tools"), { recursive: true });
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.test");
    git("config", "commit.gpgsign", "false");
    const fake = join(repo, ".tools", "gitleaks");
    writeFileSync(fake, FAKE_GITLEAKS);
    chmodSync(fake, 0o755);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("scans the pushed range with both configs", () => {
    const base = commit("a");
    const tip = commit("b");

    const result = push([`refs/heads/main ${tip} refs/heads/main ${base}`]);

    expect(result.status).toBe(0);
    const calls = scans();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("/.gitleaks.toml");
    expect(calls[1]).toContain("/.gitleaks-custom.toml");
    for (const call of calls) {
      expect(call).toContain(`--log-opts=${base}..${tip} -m`);
      expect(call).toContain("--ignore-gitleaks-allow");
    }
  });

  it("scans a new branch against the remote's refs", () => {
    const tip = commit("a");

    expect(
      push([`refs/heads/main ${tip} refs/heads/main ${ZERO}`]).status,
    ).toBe(0);
    expect(scans()).toHaveLength(2);
    for (const call of scans()) {
      expect(call).toContain(`--log-opts=${tip} --not --remotes=origin -m`);
    }
  });

  it("skips a delete", () => {
    const tip = commit("a");

    expect(push([`(delete) ${ZERO} refs/heads/old ${tip}`]).status).toBe(0);
    expect(scans()).toEqual([]);
  });

  it("blocks the push on a finding", () => {
    const tip = commit("a");

    expect(
      push([`refs/heads/main ${tip} refs/heads/main ${ZERO}`], 1).status,
    ).not.toBe(0);
  });

  it("refuses to run with a .gitleaksignore file", () => {
    const tip = commit("a");
    writeFileSync(join(repo, ".gitleaksignore"), "");

    const result = push([`refs/heads/main ${tip} refs/heads/main ${ZERO}`]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(".gitleaksignore");
    expect(scans()).toEqual([]);
  });
});
