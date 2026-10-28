import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type UpdateFixture = {
  badSignature: boolean;
  badDownload: boolean;
  confirmation: number;
  confirmations: number;
  opened: string[];
  backupsAtOpen: string[];
  hold?: 'metadata' | 'download' | 'consent' | 'hash';
  held?: boolean;
  releaseHeld?: () => void;
};

export async function signedUpdateFixture(directory: string) {
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const bytes = Buffer.from('Harmless installer fixture. Never execute.');
  const extension =
    process.platform === 'win32' ? 'exe' : process.platform === 'darwin' ? 'dmg' : 'AppImage';
  const artifact = `https://github.com/ArmandSyah/interview-mcp/releases/download/v99.0.0/fixture.${extension}`;
  const manifestUrl =
    'https://github.com/ArmandSyah/interview-mcp/releases/download/v99.0.0/signed-release.json';
  const payload = Buffer.from(
    JSON.stringify({
      formatVersion: 1,
      version: '99.0.0',
      engineVersion: '99.0.0',
      channel: 'stable',
      minSchemaVersion: 4,
      maxSchemaVersion: 4,
      releasedAt: '2026-10-01T00:00:00Z',
      notes: 'Signed native fixture.',
      artifacts: [
        {
          platform: process.platform,
          arch: process.arch,
          url: artifact,
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    }),
  );
  const envelope = {
    payload: payload.toString('base64'),
    signature: sign(null, payload, keys.privateKey).toString('base64'),
  };
  const entry = join(directory, 'signed-update-entry.cjs');
  // Compile the real bundle with one ephemeral trust-key substitution. Keep all IPC handlers,
  // signature/hash verification, disk writes, and backup creation unchanged.
  await writeFile(
    entry,
    `
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const electron = require('electron');
const state = globalThis.updateFixture = { badSignature: true, badDownload: true, confirmation: 0, confirmations: 0, opened: [], backupsAtOpen: [] };
const originalReadStream = fs.createReadStream;
fs.createReadStream = (file, options) => {
  if (state.hold !== 'hash') return originalReadStream(file, options);
  return (async function* () {
    state.held = true;
    await new Promise((resolve, reject) => {
      state.releaseHeld = () => reject(new Error('Fixture hash cancelled'));
      options?.signal?.addEventListener('abort', state.releaseHeld, { once: true });
    });
    yield* originalReadStream(file, options);
  })();
};
globalThis.fetch = async (input, options) => {
  const url = String(input);
  if (state.hold === 'metadata' && url.includes('api.github.com')) {
    state.held = true;
    return new Promise((resolve, reject) => {
      state.releaseHeld = () => reject(new Error('Fixture metadata cancelled'));
      options.signal.addEventListener('abort', state.releaseHeld, { once: true });
    });
  }
  if (url === 'https://api.github.com/repos/ArmandSyah/interview-mcp/releases/latest') return Response.json({ draft: false, prerelease: false, tag_name: 'v99.0.0', assets: [{ name: 'signed-release.json', browser_download_url: ${JSON.stringify(manifestUrl)} }] });
  if (url === ${JSON.stringify(manifestUrl)}) {
    const envelope = ${JSON.stringify(envelope)};
    if (state.badSignature) { envelope.signature = Buffer.alloc(64).toString('base64'); state.badSignature = false; }
    return Response.json(envelope);
  }
  if (url === ${JSON.stringify(artifact)}) {
    if (state.hold === 'download') return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      state.held = true;
      state.releaseHeld = () => controller.error(new Error('Fixture download cancelled'));
      options.signal.addEventListener('abort', state.releaseHeld, { once: true });
    } }));
    const corrupt = state.badDownload; state.badDownload = false;
    const contents = Buffer.from(${JSON.stringify(bytes.toString('base64'))}, 'base64');
    if (corrupt) contents[0] ^= 1;
    return new Response(contents);
  }
  throw new Error('Unexpected fixture network request: ' + url);
};
electron.dialog.showMessageBox = async () => {
  state.confirmations++;
  if (state.hold === 'consent') {
    state.held = true;
    return new Promise(resolve => { state.releaseHeld = () => resolve({ response: 1, checkboxChecked: false }); });
  }
  return { response: state.confirmation, checkboxChecked: false };
};
electron.shell.openPath = async (file) => {
  const directory = path.join(electron.app.getPath('userData'), 'backups');
  state.backupsAtOpen = fs.readdirSync(directory).map(name => fs.readFileSync(path.join(directory, name), 'utf8'));
  state.opened.push(file);
  fs.writeFileSync(${JSON.stringify(join(directory, 'installer-opened'))}, file);
  return '';
};
const original = ${JSON.stringify(resolve('dist/main/index.cjs'))};
let source = fs.readFileSync(original, 'utf8');
const marker = 'releasePublicKey: ""';
if (source.split(marker).length !== 2) throw new Error('Expected one unconfigured release key in the source bundle');
source = source.replace(marker, 'releasePublicKey: ' + ${JSON.stringify(JSON.stringify(publicKey))});
const loaded = new Module(original, module);
loaded.filename = original;
loaded.paths = Module._nodeModulePaths(path.dirname(original));
loaded._compile(source, original);
`,
  );
  return { entry, bytes, installerName: `fixture.${extension}` };
}
