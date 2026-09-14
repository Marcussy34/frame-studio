import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  describeExit,
  findAgy,
  PLANNING_MODEL,
  PLANNING_TIMEOUT,
  type Filesystem,
} from '../desktop/zoom-planner/agy';

const cache = join(
  homedir(),
  '.claude',
  'plugins',
  'cache',
  'antigravity-for-claude-code',
  'antigravity',
);
const marketplace = join(
  homedir(),
  '.claude',
  'plugins',
  'marketplaces',
  'antigravity-for-claude-code',
);

// A stand-in filesystem, so these tests say nothing about what happens to be installed
// on the machine running them.
function files(present: string[], versions: Record<string, string[]> = {}): Filesystem {
  return {
    exists: (path) => present.includes(path),
    versions: (path) => versions[path] ?? [],
  };
}

describe('findAgy', () => {
  it('finds the delegate script in the plugin cache and the binary beside it', () => {
    const script = join(cache, '0.23.0', 'scripts', 'agy-delegate.sh');
    const found = findAgy(files([script, '/opt/homebrew/bin/agy'], { [cache]: ['0.23.0'] }));
    expect(found).toEqual({ script, binDirectory: '/opt/homebrew/bin' });
  });

  it('prefers the newest installed plugin version', () => {
    const newest = join(cache, '0.23.0', 'scripts', 'agy-delegate.sh');
    const older = join(cache, '0.9.0', 'scripts', 'agy-delegate.sh');
    const found = findAgy(
      files([newest, older, '/opt/homebrew/bin/agy'], { [cache]: ['0.9.0', '0.23.0'] }),
    );
    expect(found?.script).toBe(newest);
  });

  it('falls back to an unversioned marketplace checkout', () => {
    const script = join(marketplace, 'scripts', 'agy-delegate.sh');
    expect(findAgy(files([script, '/usr/local/bin/agy']))?.script).toBe(script);
  });

  it('reports unavailable when the script is missing', () => {
    expect(findAgy(files(['/opt/homebrew/bin/agy']))).toBeNull();
  });

  it('reports unavailable when the binary is missing, even with the script present', () => {
    // The script shells out to agy, so a script with no binary behind it is useless.
    const script = join(marketplace, 'scripts', 'agy-delegate.sh');
    expect(findAgy(files([script]))).toBeNull();
  });

  it('never resolves from PATH', () => {
    // The whole reason this module exists: an app launched from Finder inherits
    // launchd's PATH and would never see a package manager's bin directory.
    const script = join(marketplace, 'scripts', 'agy-delegate.sh');
    const found = findAgy(files([script, '/opt/homebrew/bin/agy']));
    expect(found?.binDirectory).toBe('/opt/homebrew/bin');
    expect(found?.binDirectory).not.toBe('');
  });
});

describe('describeExit', () => {
  it('says something the user can act on for quota and auth', () => {
    expect(describeExit(10)).toMatch(/quota/i);
    expect(describeExit(11)).toMatch(/signed in/i);
  });

  it('distinguishes a timeout, a missing CLI and an empty reply', () => {
    const messages = [12, 13, 3].map(describeExit);
    expect(new Set(messages).size).toBe(3);
  });

  it('always says the automatic zoom was kept, because nothing is lost', () => {
    for (const code of [2, 3, 10, 11, 12, 13, 14, 99, null]) {
      expect(describeExit(code)).toMatch(/automatic zoom|signed in/i);
    }
  });
});

describe('planning defaults', () => {
  it('pins an exact model rather than a tier alias', () => {
    // --tier flash-lo resolves to a Gemini 3.5 model that `agy models` does not list on
    // this plan and fails with exit 14, so a tier is not a safe thing to depend on.
    expect(PLANNING_MODEL).toBe('Gemini 3.8 Flash (Medium)');
    expect(PLANNING_MODEL).not.toMatch(/^(flash|pro)/);
  });

  it('allows far longer than one agy round trip', () => {
    // Measured: describing four frames took 235s and a full planning turn 346s, because
    // agy runs a multi-turn agent loop. On expiry agy returns nothing at all rather than
    // partial text, so a short timeout discards the answer instead of degrading it.
    const minutes = Number(PLANNING_TIMEOUT.replace('m', ''));
    expect(PLANNING_TIMEOUT).toMatch(/^\d+m$/);
    expect(minutes).toBeGreaterThanOrEqual(10);
  });
});
