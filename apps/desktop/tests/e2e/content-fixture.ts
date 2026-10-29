import { execFile } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

export type ContentFixtureState = {
  canceled: boolean;
  paths: string[];
  selections: number;
  opened: string[];
  shellError: string;
};

export async function contentFixture(directory: string) {
  const root = resolve('../..');
  const python =
    process.env.INTERVIEW_DESKTOP_PYTHON ??
    join(root, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
  // Reuse public backend fixtures. No private exercise content is read.
  const { stdout } = await promisify(execFile)(
    python,
    [
      '-c',
      'import json; from tests.test_content_packs import manifest, license_claims; print(json.dumps([manifest(), license_claims()]))',
    ],
    { cwd: root, env: { ...process.env, INTERVIEW_MCP_DB_DIR: join(directory, 'manifest-data') } },
  );
  const [manifest, license] = JSON.parse(stdout);
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const envelope = (value: unknown) => {
    const payload = Buffer.from(JSON.stringify(value));
    return JSON.stringify({
      payload: payload.toString('base64'),
      signature: sign(null, payload, keys.privateKey).toString('base64'),
    });
  };
  const pack = join(directory, 'pack.json');
  const claims = join(directory, 'license.json');
  const invalid = join(directory, 'invalid.json');
  const corrupt = join(directory, 'corrupt.json');
  const signed = envelope(manifest);
  await writeFile(pack, signed);
  await writeFile(claims, envelope(license));
  await writeFile(invalid, '{}');
  await writeFile(
    corrupt,
    JSON.stringify({ ...JSON.parse(signed), signature: Buffer.alloc(64).toString('base64') }),
  );
  const checkout = 'https://buy.stripe.com/fixture-desktop-test';
  const bootstrap = [
    'import runpy',
    'from server.distribution import signatures',
    `signatures.trust_config = lambda: ${JSON.stringify({ contentPublicKey: publicKey })}`,
    'runpy.run_module("server.desktop", run_name="__main__")',
  ].join('\n');
  const entry = join(directory, 'content-entry.cjs');
  // Only trust and native picker/browser boundaries change. The real backend verifies signatures
  // and writes the temporary database. The checked-in trust file and bundle stay unchanged.
  await writeFile(
    entry,
    `
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const electron = require('electron');
const state = globalThis.contentFixture = { canceled: true, paths: [], selections: 0, opened: [], shellError: '' };
electron.dialog.showOpenDialog = async () => {
  state.selections++;
  return { canceled: state.canceled, filePaths: state.paths };
};
electron.shell.openExternal = async (url) => {
  state.opened.push(url);
  if (state.shellError) throw new Error(state.shellError);
};
const original = ${JSON.stringify(resolve('dist/main/index.cjs'))};
let source = fs.readFileSync(original, 'utf8');
for (const [marker, replacement] of ${JSON.stringify([
      ['contentPublicKey: ""', `contentPublicKey: ${JSON.stringify(publicKey)}`],
      ['checkoutUrl: ""', `checkoutUrl: ${JSON.stringify(checkout)}`],
      ['["-m", "server.desktop"]', JSON.stringify(['-c', bootstrap])],
    ])}) {
  if (source.split(marker).length !== 2) throw new Error('Expected one source marker: ' + marker);
  source = source.replace(marker, () => replacement);
}
const loaded = new Module(original, module);
loaded.filename = original;
loaded.paths = Module._nodeModulePaths(path.dirname(original));
loaded._compile(source, original);
`,
  );
  return { entry, pack, claims, invalid, corrupt, checkout };
}
