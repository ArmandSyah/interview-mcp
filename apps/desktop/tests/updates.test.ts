import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { compareVersions, ReleaseUpdates, verifyReleaseManifest } from '../src/main/updates';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const bytes = Buffer.from('fixture installer, never executed');
function manifest() {
  return {
    formatVersion: 1,
    version: '0.3.0',
    engineVersion: '0.3.0',
    channel: 'stable',
    minSchemaVersion: 4,
    maxSchemaVersion: 4,
    releasedAt: '2026-10-01T00:00:00Z',
    notes: 'Fixture release',
    artifacts: [
      {
        platform: 'linux',
        arch: 'x64',
        url: 'https://github.com/ArmandSyah/interview-mcp/releases/download/v0.3.0/fixture.AppImage',
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    ],
  };
}
function envelope(value = manifest()) {
  const payload = Buffer.from(JSON.stringify(value));
  return {
    payload: payload.toString('base64'),
    signature: sign(null, payload, keys.privateKey).toString('base64'),
  };
}

it('orders beta and stable versions without lexicographic mistakes', () => {
  expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
  expect(compareVersions('0.3.0-beta.11', '0.3.0-beta.2')).toBe(1);
  expect(compareVersions('0.3.0', '0.3.0-beta.11')).toBe(1);
  expect(compareVersions('0.2.0', '0.3.0')).toBe(-1);
});
it('rejects unsigned/tampered releases, channel mixing, foreign URLs, and engine/schema mismatch', () => {
  expect(verifyReleaseManifest(envelope(), publicKey, 'stable').version).toBe('0.3.0');
  const tampered = envelope();
  tampered.payload = Buffer.from('{}').toString('base64');
  expect(() => verifyReleaseManifest(tampered, publicKey, 'stable')).toThrow('signature');
  expect(() => verifyReleaseManifest(envelope(), publicKey, 'beta')).toThrow('channel');
  expect(() =>
    verifyReleaseManifest(envelope({ ...manifest(), engineVersion: '0.4.0' }), publicKey, 'stable'),
  ).toThrow('together');
  expect(() =>
    verifyReleaseManifest(envelope({ ...manifest(), minSchemaVersion: 5 }), publicKey, 'stable'),
  ).toThrow('schema');
  const external = manifest();
  external.artifacts[0].url = 'https://untrusted.invalid/fixture.AppImage';
  expect(() => verifyReleaseManifest(envelope(external), publicKey, 'stable')).toThrow(
    'repository',
  );
});
it('never calls the network when signing is unconfigured', async () => {
  const request = vi.fn();
  const updates = new ReleaseUpdates('/tmp/unused', '0.2.0', '', 'linux', 'x64', request);
  expect((await updates.check('stable')).state).toBe('unconfigured');
  expect(request).not.toHaveBeenCalled();
});
it('verifies metadata and downloaded bytes, and catches post-download tampering before opening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'interview-update-'));
  const request = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('api.github.com'))
      return Response.json({
        draft: false,
        prerelease: false,
        tag_name: 'v0.3.0',
        assets: [
          {
            name: 'signed-release.json',
            browser_download_url:
              'https://github.com/ArmandSyah/interview-mcp/releases/download/v0.3.0/signed-release.json',
          },
        ],
      });
    if (url.endsWith('signed-release.json')) return Response.json(envelope());
    return new Response(bytes);
  });
  const updates = new ReleaseUpdates(root, '0.2.0', publicKey, 'linux', 'x64', request);
  expect((await updates.check('stable')).state).toBe('available');
  expect((await updates.download()).state).toBe('ready');
  const path = await updates.installerPath();
  await writeFile(path, 'malicious replacement');
  await expect(updates.installerPath()).rejects.toThrow('changed');
});
it('rejects corrupted downloads and redirects to loopback or another host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'interview-update-'));
  let redirect = false;
  const request = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('api.github.com'))
      return Response.json({
        draft: false,
        prerelease: false,
        tag_name: 'v0.3.0',
        assets: [
          {
            name: 'signed-release.json',
            browser_download_url:
              'https://github.com/ArmandSyah/interview-mcp/releases/download/v0.3.0/signed-release.json',
          },
        ],
      });
    if (url.endsWith('signed-release.json')) return Response.json(envelope());
    return redirect
      ? new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private' } })
      : new Response(Buffer.from('damaged'));
  });
  const updates = new ReleaseUpdates(root, '0.2.0', publicKey, 'linux', 'x64', request);
  await updates.check('stable');
  await expect(updates.download()).rejects.toThrow('checksum');
  expect(updates.info().state).toBe('available');
  redirect = true;
  await expect(updates.download()).rejects.toThrow('redirect');
});
