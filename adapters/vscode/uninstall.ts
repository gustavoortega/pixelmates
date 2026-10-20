/**
 * `vscode:uninstall` hook (see package.json scripts) — VS Code executes this
 * with plain Node after the extension has been fully uninstalled. The `vscode`
 * module does not exist here; only Node APIs are available.
 *
 * Takes every registered provider out of ~/.claude/settings.json (the hook
 * entries, and the status line wrapper, whose original command goes back in
 * place) so an uninstalled extension leaves nothing running behind the user's
 * back. The copied scripts under ~/.pixelmates/hooks/ are left in place: the
 * standalone CLI shares them, and a wrapper the restore could not undo (a
 * status line edited by hand since) still needs its script to keep running the
 * user's command.
 */
import { resetHooksConfig } from '../../server/src/configPersistence.js';
import { hookProviders } from '../../server/src/providers/index.js';

// There is no UI to surface errors to after uninstall — log and exit cleanly
// (an unhandledRejection here would just be noise in VS Code's uninstall flow).
// One provider at a time: they write the same file, and one failure must not
// keep the others in place.
async function uninstallAll(): Promise<void> {
  for (const provider of hookProviders) {
    try {
      await provider.uninstallHooks();
    } catch (err: unknown) {
      console.error(`[pixelmates] ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

void uninstallAll().finally(() => {
  resetHooksConfig();
});
