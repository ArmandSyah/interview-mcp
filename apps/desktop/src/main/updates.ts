import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import type { ReleaseChannel, UpdateStatus } from '../shared/updates';
import { DATABASE_SCHEMA_VERSION } from '../shared/practice';

const version = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.[1-9]\d*)?$/);
const artifactSchema = z
  .object({
    platform: z.enum(['linux', 'win32', 'darwin']),
    arch: z.enum(['x64', 'arm64']),
    url: z.string().url(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().min(1).max(600_000_000),
  })
  .strict();
const manifestSchema = z
  .object({
    formatVersion: z.literal(1),
    version,
    engineVersion: version,
    channel: z.enum(['stable', 'beta']),
    minSchemaVersion: z.number().int().min(0),
    maxSchemaVersion: z.number().int().min(0),
    releasedAt: z.iso.datetime({ offset: true }),
    notes: z.string().max(8000),
    artifacts: z.array(artifactSchema).min(1).max(20),
  })
  .strict();
type Manifest = z.infer<typeof manifestSchema>;
type Artifact = z.infer<typeof artifactSchema>;
const repo = 'ArmandSyah/interview-mcp';
const envelopeSchema = z
  .object({ payload: z.string().max(300_000), signature: z.string().max(128) })
  .strict();

export function compareVersions(left: string, right: string): number {
  version.parse(left);
  version.parse(right);
  const [a, betaA] = left.split('-beta.'),
    [b, betaB] = right.split('-beta.');
  const first = a.split('.').map(Number),
    second = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (first[i] !== second[i]) return Math.sign(first[i] - second[i]);
  if (!betaA && !betaB) return 0;
  if (!betaA) return 1;
  if (!betaB) return -1;
  return Math.sign(Number(betaA) - Number(betaB));
}
function artifactUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith('/' + repo + '/releases/download/') ||
    /%|\.\./.test(url.pathname)
  )
    throw new Error('Release artifacts must come from the configured public GitHub repository');
  if (!/\.(exe|dmg|deb|AppImage)$/.test(url.pathname))
    throw new Error('Unsupported installer artifact');
  return url;
}
export function verifyReleaseManifest(
  input: unknown,
  publicKey: string,
  channel: ReleaseChannel,
): Manifest {
  if (!publicKey) throw new Error('Release signing is not configured');
  const envelope = envelopeSchema.parse(input);
  const payload = Buffer.from(envelope.payload, 'base64'),
    signature = Buffer.from(envelope.signature, 'base64');
  const key = createPublicKey(publicKey);
  if (
    key.asymmetricKeyType !== 'ed25519' ||
    signature.length !== 64 ||
    payload.length > 200_000 ||
    payload.toString('base64') !== envelope.payload ||
    signature.toString('base64') !== envelope.signature ||
    !verify(null, payload, key, signature)
  )
    throw new Error('Release signature is invalid');
  const manifest = manifestSchema.parse(JSON.parse(payload.toString('utf8')));
  if (
    manifest.channel !== channel ||
    (channel === 'stable' && manifest.version.includes('-')) ||
    (channel === 'beta' && !manifest.version.includes('-beta.'))
  )
    throw new Error('Release channel does not match');
  if (manifest.engineVersion !== manifest.version)
    throw new Error('App and engine must be released together');
  if (
    manifest.minSchemaVersion > DATABASE_SCHEMA_VERSION ||
    manifest.maxSchemaVersion < DATABASE_SCHEMA_VERSION
  )
    throw new Error('Release is incompatible with this database schema');
  for (const artifact of manifest.artifacts) {
    const url = artifactUrl(artifact.url);
    if (!url.pathname.startsWith('/' + repo + '/releases/download/v' + manifest.version + '/'))
      throw new Error('Artifact is not bound to this release version');
  }
  return manifest;
}

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error('Release metadata could not be fetched');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('Release metadata is too large');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel();
  }
}

export class ReleaseUpdates {
  private manifest: Manifest | null = null;
  private artifact: Artifact | null = null;
  private downloaded: string | null = null;
  private busy = false;
  private status: UpdateStatus;
  constructor(
    private readonly root: string,
    private readonly currentVersion: string,
    private readonly publicKey: string,
    private readonly platform = process.platform,
    private readonly arch = process.arch,
    private readonly request = fetch,
  ) {
    this.status = {
      state: publicKey ? 'idle' : 'unconfigured',
      version: null,
      notes: '',
      message: publicKey
        ? 'Updates are checked only when you ask.'
        : 'Signed updates are not configured in this preview build.',
    };
  }
  info(): UpdateStatus {
    return { ...this.status };
  }
  private async fetch(url: string): Promise<Response> {
    return this.request(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: { Accept: 'application/vnd.github+json' },
    });
  }
  private async resource(url: string, timeout: number): Promise<Response> {
    for (let redirects = 0; redirects < 5; redirects++) {
      const response = await this.request(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeout),
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      await response.body?.cancel();
      const next = new URL(response.headers.get('location') ?? '', url);
      if (
        next.protocol !== 'https:' ||
        next.username ||
        next.password ||
        !(next.hostname === 'github.com' || next.hostname.endsWith('.githubusercontent.com'))
      )
        throw new Error('Unexpected release resource redirect');
      url = next.href;
    }
    throw new Error('Too many release resource redirects');
  }
  async check(channel: ReleaseChannel): Promise<UpdateStatus> {
    if (!this.publicKey) return this.info();
    if (this.busy) throw new Error('An update operation is already running');
    this.busy = true;
    try {
      const endpoint = `https://api.github.com/repos/${repo}/releases${channel === 'stable' ? '/latest' : '?per_page=20'}`;
      const metadata = await boundedJson(await this.fetch(endpoint), 2_000_000);
      const releases = z
        .array(
          z.object({
            draft: z.boolean(),
            prerelease: z.boolean(),
            tag_name: z.string(),
            assets: z.array(z.object({ name: z.string(), browser_download_url: z.string().url() })),
          }),
        )
        .parse(channel === 'stable' ? [metadata] : metadata);
      const release = releases.find(
        (item) => !item.draft && (channel === 'stable' ? !item.prerelease : item.prerelease),
      );
      const asset = release?.assets.find((item) => item.name === 'signed-release.json');
      if (
        !release ||
        !asset ||
        asset.browser_download_url !==
          `https://github.com/${repo}/releases/download/${release.tag_name}/signed-release.json`
      )
        throw new Error('No signed release manifest is available');
      const manifestResponse = await this.resource(asset.browser_download_url, 30_000);
      const manifest = verifyReleaseManifest(
        await boundedJson(manifestResponse, 400_000),
        this.publicKey,
        channel,
      );
      if (release.tag_name !== 'v' + manifest.version)
        throw new Error('Signed version does not match the release tag');
      const artifact = manifest.artifacts.find(
        (item) => item.platform === this.platform && item.arch === this.arch,
      );
      if (!artifact) throw new Error('This release has no installer for your platform');
      this.manifest = manifest;
      this.artifact = artifact;
      this.downloaded = null;
      this.status = {
        state: compareVersions(manifest.version, this.currentVersion) > 0 ? 'available' : 'idle',
        version: manifest.version,
        notes: manifest.notes,
        message:
          compareVersions(manifest.version, this.currentVersion) > 0
            ? 'Verified update available. Nothing will install during practice.'
            : 'You are up to date.',
      };
      return this.info();
    } finally {
      this.busy = false;
    }
  }
  async download(): Promise<UpdateStatus> {
    if (this.busy || this.status.state !== 'available' || !this.artifact || !this.manifest)
      throw new Error('Check for an available signed update first');
    this.busy = true;
    const directory = join(this.root, 'updates', this.manifest.version);
    const path = join(directory, basename(artifactUrl(this.artifact.url).pathname));
    const temporary = path + '.' + randomUUID() + '.partial';
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const response = await this.resource(this.artifact.url, 300_000);
      if (!response?.ok || !response.body) throw new Error('Installer download failed');
      const reader = response.body.getReader();
      const file = await open(temporary, 'wx', 0o600);
      const hash = createHash('sha256');
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > this.artifact.size) throw new Error('Installer exceeds its signed size');
          hash.update(value);
          await file.writeFile(value);
        }
        if (size !== this.artifact.size || hash.digest('hex') !== this.artifact.sha256)
          throw new Error('Installer checksum failed');
        await file.sync();
      } finally {
        await reader.cancel();
        await file.close();
      }
      await rename(temporary, path);
      this.downloaded = path;
      this.status = {
        ...this.status,
        state: 'ready',
        message: 'Verified installer downloaded. Open it only when you are ready.',
      };
      return this.info();
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    } finally {
      this.busy = false;
    }
  }
  async installerPath(): Promise<string> {
    if (!this.downloaded || !this.artifact || this.status.state !== 'ready')
      throw new Error('Download a verified installer first');
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of createReadStream(this.downloaded)) {
      size += chunk.length;
      if (size > this.artifact.size) throw new Error('Downloaded installer changed');
      hash.update(chunk);
    }
    if (size !== this.artifact.size || hash.digest('hex') !== this.artifact.sha256)
      throw new Error('Downloaded installer changed; download it again');
    return this.downloaded;
  }
}
