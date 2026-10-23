import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  getPublicationDecision,
  normalizePackMetadata,
  parseNpmViewField,
  parsePackJsonOutput,
  REQUIRED_PACKAGE_FILES,
  REQUIRED_PACKAGE_PREFIXES,
  validatePackageFiles,
  validatePackedSize,
  validateReleaseIdentity,
  validateTarballIntegrity,
} from './npm-package-contract.mjs';

function validFiles() {
  return [
    ...REQUIRED_PACKAGE_FILES,
    ...REQUIRED_PACKAGE_PREFIXES.map((prefix) => `${prefix}fixture.dat`),
  ].map((path) => ({ path }));
}

test('normalizes npm pack array and keyed-object output', () => {
  const metadata = { filename: 'pixelmates-1.0.0.tgz', files: validFiles() };
  assert.equal(normalizePackMetadata([metadata]), metadata);
  assert.equal(normalizePackMetadata({ 'pixelmates@1.0.0': metadata }), metadata);
});

test('extracts pack JSON after lifecycle build output', () => {
  const metadata = [{ filename: 'pixelmates-1.0.0.tgz', files: validFiles() }];
  const output = `[generate-messages] built protocol\nHUSKY=0 skip install${JSON.stringify(metadata)}`;
  assert.deepEqual(parsePackJsonOutput(output), metadata);
});

test('rejects a known-bad tarball missing the shipped hook', () => {
  const files = validFiles().filter((file) => file.path !== 'dist/hooks/claude-hook.js');
  assert.throws(
    () => validatePackageFiles(files),
    /missing required file: dist\/hooks\/claude-hook\.js/,
  );
});

test('rejects source and preview files even when required files exist', () => {
  assert.throws(
    () => validatePackageFiles([...validFiles(), { path: 'server/src/cli.ts' }]),
    /forbidden package path: server\/src\/cli\.ts/,
  );
  assert.throws(
    () => validatePackageFiles([...validFiles(), { path: 'dist/browser/index.html' }]),
    /forbidden package path: dist\/browser\/index\.html/,
  );
  assert.throws(
    () => validatePackageFiles([...validFiles(), { path: 'dist/webview/assets/demo.gif' }]),
    /gif must not ship: dist\/webview\/assets\/demo\.gif/,
  );
});

test('validates release tag, ref, repository, and monotonic version', () => {
  const manifest = {
    name: '@pixelmates/cli',
    version: '1.4.0',
    repository: { url: 'git+https://github.com/gustavoortega/pixelmates.git' },
  };
  assert.doesNotThrow(() =>
    validateReleaseIdentity({
      manifest,
      releaseTag: 'v1.4.0',
      ref: 'refs/tags/v1.4.0',
      latestVersion: '1.0.2',
    }),
  );
  assert.throws(
    () =>
      validateReleaseIdentity({
        manifest,
        releaseTag: 'v1.3.0',
        ref: 'refs/tags/v1.3.0',
        latestVersion: '1.0.2',
      }),
    /does not match package version/,
  );
  assert.throws(
    () =>
      validateReleaseIdentity({
        manifest: { ...manifest, version: '1.0.2' },
        releaseTag: 'v1.0.2',
        ref: 'refs/tags/v1.0.2',
        latestVersion: '1.0.2',
      }),
    /must be greater than npm latest/,
  );
  assert.doesNotThrow(() =>
    validateReleaseIdentity({
      manifest: { ...manifest, version: '1.0.2' },
      releaseTag: 'v1.0.2',
      ref: 'refs/tags/v1.0.2',
      latestVersion: '1.0.2',
      exactVersionExists: true,
    }),
  );
});

test('rejects the upstream package name and a foreign repository', () => {
  const base = {
    releaseTag: 'v1.4.0',
    ref: 'refs/tags/v1.4.0',
    latestVersion: '1.0.2',
  };
  const manifest = {
    name: '@pixelmates/cli',
    version: '1.4.0',
    repository: { url: 'git+https://github.com/gustavoortega/pixelmates.git' },
  };
  assert.throws(
    () => validateReleaseIdentity({ ...base, manifest: { ...manifest, name: 'pixel-agents' } }),
    /Expected package name @pixelmates\/cli/,
  );
  assert.throws(
    () =>
      validateReleaseIdentity({
        ...base,
        manifest: {
          ...manifest,
          repository: { url: 'https://github.com/pixel-agents-hq/pixel-agents' },
        },
      }),
    /Expected repository/,
  );
});

test('a never-published package has no latest to beat', () => {
  assert.doesNotThrow(() =>
    validateReleaseIdentity({
      manifest: {
        name: '@pixelmates/cli',
        version: '1.0.0',
        repository: { url: 'git+https://github.com/gustavoortega/pixelmates.git' },
      },
      releaseTag: 'v1.0.0',
      ref: 'refs/tags/v1.0.0',
      latestVersion: null,
    }),
  );
});

test('publishes only absent versions and treats integrity safely', () => {
  assert.equal(getPublicationDecision('sha512-local', null), 'publish');
  assert.equal(getPublicationDecision('sha512-same', 'sha512-same'), 'skip');
  assert.equal(getPublicationDecision('sha512-local', 'sha512-other'), 'conflict');
});

test('rejects a tarball changed after its metadata was created', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixelmates-integrity-test-'));
  const tarballPath = path.join(tmpDir, 'pixelmates.tgz');
  const verifiedIntegrity =
    'sha512-RkN76vtkA1+8p/GSGfbyKAGc1SvEWGcyy0e6CVFdcQKBmX1sAD93WjE7XaXvLvWCO8Q8zHEugymaUbvwb3dBXg==';
  try {
    fs.writeFileSync(tarballPath, 'verified tarball');
    assert.equal(validateTarballIntegrity(tarballPath, verifiedIntegrity), verifiedIntegrity);

    fs.writeFileSync(tarballPath, 'tampered tarball');
    assert.throws(
      () => validateTarballIntegrity(tarballPath, verifiedIntegrity),
      /integrity changed after verification/,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('rejects a tarball over the size ceiling', () => {
  assert.doesNotThrow(() => validatePackedSize(1_100_000));
  assert.throws(() => validatePackedSize(2 * 1024 * 1024 + 1), /exceeds the 2097152 byte ceiling/);
});

test('reads one npm view field from npm 10 and npm 12 output alike', () => {
  assert.equal(parseNpmViewField('"1.0.0"\n'), '1.0.0');
  assert.equal(parseNpmViewField('[\n  "1.0.0"\n]\n'), '1.0.0');
  assert.throws(() => parseNpmViewField('["1.0.0", "1.0.1"]'), /Expected one value/);
});
