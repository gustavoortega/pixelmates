const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
/** `npm run plugin:build`: only the memory MCP bundle. */
const memoryMcpOnly = process.argv.includes('--memory-mcp');

/** Extension version read from package.json at build time, inlined via esbuild `define`. */
const pkgVersion = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'),
).version;
const versionDefine = {
  'process.env.PIXELMATES_VERSION': JSON.stringify(pkgVersion),
};

/**
 * Copy assets folder to dist/assets
 */
function copyAssets() {
  const srcDir = path.join(__dirname, 'webview-ui', 'public', 'assets');
  const dstDir = path.join(__dirname, 'dist', 'assets');

  if (fs.existsSync(srcDir)) {
    // Remove existing dist/assets if present
    if (fs.existsSync(dstDir)) {
      fs.rmSync(dstDir, { recursive: true });
    }

    // Copy recursively
    fs.cpSync(srcDir, dstDir, { recursive: true });
    console.log('✓ Copied assets/ → dist/assets/');
  } else {
    console.log('ℹ️  assets/ folder not found (optional)');
  }
}

/**
 * Bundle the Claude scripts (TypeScript) to dist/hooks via esbuild: the hook
 * script and the status line wrapper. Each is a self-contained CJS file with a
 * shebang for Claude Code to execute. Both sources sit in the same directory,
 * which keeps esbuild's output base there: dist/hooks/<name>.js, no nesting.
 */
function buildHooks() {
  const hooksDir = path.join(__dirname, 'server', 'src', 'providers', 'hook', 'claude', 'hooks');
  const entries = ['claude-hook.ts', 'statusline-tee.ts'].map((name) => path.join(hooksDir, name));
  if (!entries.every((entry) => fs.existsSync(entry))) return;
  require('esbuild').buildSync({
    entryPoints: entries,
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outdir: path.join(__dirname, 'dist', 'hooks'),
    banner: { js: '#!/usr/bin/env node' },
  });
  console.log('✓ Built hooks/ → dist/hooks/');
}

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',

  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        console.error(`    ${location.file}:${location.line}:${location.column}:`);
      });
      console.log('[watch] build finished');
    });
  },
};

async function main() {
  if (memoryMcpOnly) {
    await buildMemoryMcp();
    return;
  }
  const ctx = await esbuild.context({
    entryPoints: ['adapters/vscode/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    define: versionDefine,
    logLevel: 'silent',
    plugins: [
      /* add to the end of plugins array */
      esbuildProblemMatcherPlugin,
    ],
  });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    // Copy assets and hooks after build
    copyAssets();
    buildHooks();
    await buildCli();
    await buildUninstall();
    await buildMemoryMcp();
  }
}

/** Bundle the vscode:uninstall hook — plain Node, runs after extension removal. */
async function buildUninstall() {
  await esbuild.build({
    entryPoints: ['adapters/vscode/uninstall.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: false,
    platform: 'node',
    outfile: 'dist/uninstall.js',
    define: versionDefine,
    logLevel: 'silent',
  });
}

/**
 * Bundle the memory MCP stdio server into the plugin (committed, so a plugin installed from git runs without a
 * build) and into dist/. Fixed options in every mode, `--production` included, so CI's build and
 * `npm run plugin:build` write the same bytes and the drift check stays meaningful. The plugin manifest's
 * version follows package.json.
 */
async function buildMemoryMcp() {
  const result = await esbuild.build({
    entryPoints: ['server/src/memory/mcpMain.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    minify: false,
    sourcemap: false,
    absWorkingDir: __dirname,
    define: versionDefine,
    write: false,
    logLevel: 'silent',
  });
  const bundle = result.outputFiles[0].contents;
  for (const outfile of ['plugin/server/memory-mcp.cjs', 'dist/memory-mcp.cjs']) {
    fs.mkdirSync(path.dirname(path.join(__dirname, outfile)), { recursive: true });
    fs.writeFileSync(path.join(__dirname, outfile), bundle);
  }
  const manifestPath = path.join(__dirname, 'plugin', '.claude-plugin', 'plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  if (manifest.version !== pkgVersion) {
    manifest.version = pkgVersion;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }
  console.log('✓ Built memory MCP → plugin/server/memory-mcp.cjs, dist/memory-mcp.cjs');
}

/** Bundle the standalone CLI entry point. */
async function buildCli() {
  await esbuild.build({
    entryPoints: ['server/src/cli.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    platform: 'node',
    outfile: 'dist/cli.js',
    external: ['fastify', '@fastify/websocket', '@fastify/static'],
    define: versionDefine,
    logLevel: 'silent',
  });
  if (!production) {
    console.log('[build] CLI bundled: dist/cli.mjs');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
