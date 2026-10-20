import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeStatuslineCommand } from '../src/providers/hook/claude/commandIdentity.js';

const UNINSTALL = path.join(__dirname, '../../dist/uninstall.js');

const USER_STATUS_LINE = { type: 'command', command: 'echo user-status', padding: 1 };
const THIRD_PARTY = { matcher: '', hooks: [{ type: 'command', command: 'echo third-party' }] };

/**
 * The vscode:uninstall hook, spawned from its bundle the way VS Code runs it: plain Node, after the extension is gone.
 * Every registered provider must come out of ~/.claude/settings.json, or the status line keeps running a wrapper
 * nobody can turn off from the app any more.
 */
describe('dist/uninstall.js', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-uninstall-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  /** Spawns the BUNDLE, so it needs `npm run build` first: a loud skip rather than a false green. The wrapper is
   *  POSIX only, like its install. */
  const itBuilt = it.skipIf(!fs.existsSync(UNINSTALL) || process.platform === 'win32');

  itBuilt('removes our hooks and restores the status line the wrapper chained', () => {
    const hooksDir = path.join(home, '.pixelmates', 'hooks');
    const settingsPath = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        model: 'opus',
        hooks: {
          Stop: [
            {
              matcher: '',
              hooks: [
                {
                  type: 'command',
                  command: `node "${path.join(hooksDir, 'claude-hook.js')}"`,
                  timeout: 5,
                },
              ],
            },
            THIRD_PARTY,
          ],
        },
        statusLine: {
          ...USER_STATUS_LINE,
          command: makeStatuslineCommand(
            path.join(hooksDir, 'statusline-tee.js'),
            USER_STATUS_LINE.command,
          ),
        },
      }),
    );

    const run = spawnSync('node', [UNINSTALL], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: 'utf8',
      timeout: 8000,
    });

    expect(run.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))).toEqual({
      model: 'opus',
      hooks: { Stop: [THIRD_PARTY] },
      statusLine: USER_STATUS_LINE,
    });
  });
});
