// Talking to the Antigravity CLI, which is where the model planning actually happens.
//
// Two things about this are not optional.
//
// PATH cannot be trusted. `agy` lives in a package manager's bin directory, and an app
// launched from Finder inherits launchd's PATH, which on this machine is unset and so
// defaults to /usr/bin:/bin:/usr/sbin:/sbin. Spawning "agy" would simply fail with
// ENOENT and look exactly like an auth problem. Verified, not assumed.
//
// The wrapper script calls `agy` itself, so resolving the script is only half the job.
// Its directory has to be prepended to the child's PATH or the script fails the same
// way one level down.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Where a package manager might have put the binary. Ordered by likelihood.
const BIN_DIRECTORIES = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  join(homedir(), '.local', 'bin'),
  join(homedir(), 'bin'),
];

const PLUGIN_ROOTS = [
  join(homedir(), '.claude', 'plugins', 'cache', 'antigravity-for-claude-code', 'antigravity'),
  join(homedir(), '.claude', 'plugins', 'marketplaces', 'antigravity-for-claude-code'),
];

export interface AgyLocation {
  script: string;
  binDirectory: string;
}

// Pinned rather than using the wrapper's tier aliases, which remap: --tier flash-lo
// resolves to a Gemini 3.5 model that `agy models` does not list on this plan, and
// fails with exit 14. An exact name is predictable.
export const PLANNING_MODEL = 'Gemini 3.8 Flash (Medium)';

// Measured, not guessed. agy is an agentic CLI running a multi-turn loop, so a round
// trip has a floor of about four minutes no matter how small the task: describing four
// frames took 235s. A full planning turn completed in 346s. The wrapper's timeout maps
// to agy's --print-timeout, and on expiry agy returns NOTHING rather than partial text,
// so a timeout set too low does not degrade the answer, it discards it.
export const PLANNING_TIMEOUT = '15m';

export interface Filesystem {
  exists(path: string): boolean;
  // Raw directory listing. Ordering is this module's job, not the filesystem's.
  versions(path: string): string[];
}

const realFilesystem: Filesystem = {
  exists: existsSync,
  versions: (path) => {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  },
};

// Newest first, comparing version segments as numbers. A plain string sort puts 0.9.0
// after 0.23.0, which would quietly pin an old plugin forever.
export function newestFirst(versions: string[]): string[] {
  const parts = (version: string) => version.split('.').map((piece) => Number(piece) || 0);
  return [...versions].sort((a, b) => {
    const left = parts(a);
    const right = parts(b);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const difference = (right[i] ?? 0) - (left[i] ?? 0);
      if (difference) return difference;
    }
    return 0;
  });
}

// Every place the delegate script could be, newest plugin version first.
function scriptCandidates(files: Filesystem): string[] {
  const candidates: string[] = [];
  for (const root of PLUGIN_ROOTS) {
    // The cache keeps one directory per installed version; the marketplace checkout
    // does not, so both shapes are tried.
    for (const version of newestFirst(files.versions(root))) {
      candidates.push(join(root, version, 'scripts', 'agy-delegate.sh'));
    }
    candidates.push(join(root, 'scripts', 'agy-delegate.sh'));
  }
  return candidates;
}

// Null means model planning is simply unavailable, which is a state the UI shows rather
// than an error it reports.
export function findAgy(files: Filesystem = realFilesystem): AgyLocation | null {
  const script = scriptCandidates(files).find((path) => files.exists(path));
  if (!script) return null;
  const binDirectory = BIN_DIRECTORIES.find((directory) => files.exists(join(directory, 'agy')));
  if (!binDirectory) return null;
  return { script, binDirectory };
}

// The wrapper's documented exit codes. Worth translating properly: "out of quota" and
// "not signed in" are things the user can act on, and both would otherwise read as a
// generic failure.
export function describeExit(code: number | null): string {
  switch (code) {
    case 10:
      return 'Antigravity is out of quota for now, so the automatic zoom was kept.';
    case 11:
      return 'Antigravity is not signed in. Run agy once in a terminal, then try again.';
    case 12:
      return 'Planning took too long and was stopped, so the automatic zoom was kept.';
    case 13:
      return 'The Antigravity CLI could not be found, so the automatic zoom was kept.';
    case 14:
      return 'That Antigravity model is unavailable, so the automatic zoom was kept.';
    case 3:
      return 'Antigravity returned nothing, so the automatic zoom was kept.';
    default:
      return 'Planning did not finish, so the automatic zoom was kept.';
  }
}

export class AgyError extends Error {
  constructor(
    readonly code: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'AgyError';
  }
}

export interface AgyRequest {
  location: AgyLocation;
  prompt: string;
  directory: string;
  signal?: AbortSignal;
  timeout?: string;
  model?: string;
}

// One attempt. `select` is either an exact model name or a tier alias, and the wrapper
// takes those through different flags. The retry lives in runAgy below.
function spawnAgy(
  options: AgyRequest & { select: { flag: '--model' | '--tier'; value: string } },
): Promise<string> {
  const { location, prompt, directory, signal, timeout = PLANNING_TIMEOUT, select } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(
      '/bin/bash',
      [
        location.script,
        select.flag,
        select.value,
        '--dir',
        directory,
        '--timeout',
        timeout,
        // The prompt arrives on stdin rather than as an argument, so a long recording's
        // summary cannot run into the argument length limit.
        '-',
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        // The script shells out to `agy`, so its directory has to be reachable.
        env: { ...process.env, PATH: `${location.binDirectory}:${process.env.PATH ?? ''}` },
      },
    );

    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));

    const abort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });

    child.on('error', (error) => {
      signal?.removeEventListener('abort', abort);
      reject(new AgyError(null, error.message));
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) {
        reject(new AgyError(null, 'Planning was cancelled.'));
        return;
      }
      if (code === 0 && out.trim()) resolve(out);
      // stderr carries the wrapper's own AGY_SIGNAL diagnostics, which are worth
      // keeping in the log even though the user sees the translated message.
      else
        reject(new AgyError(code, `${describeExit(code)}${err.trim() ? ` (${err.trim()})` : ''}`));
    });

    child.stdin.end(prompt);
  });
}

export async function runAgy(options: AgyRequest): Promise<string> {
  const model = options.model ?? PLANNING_MODEL;
  try {
    return await spawnAgy({ ...options, select: { flag: '--model', value: model } });
  } catch (error) {
    // A pinned model can disappear when an account's plan changes. Falling back to the
    // wrapper's own tier keeps planning working rather than failing on a name.
    if (error instanceof AgyError && error.code === 14) {
      return spawnAgy({ ...options, select: { flag: '--tier', value: 'flash' } });
    }
    throw error;
  }
}
