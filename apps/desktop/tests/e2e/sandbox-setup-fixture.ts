import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { PISTON_IMAGE } from '../../src/main/sandbox';

export const sandboxContainerId = 'a'.repeat(64);
export const sandboxRawError = 'fixture-registry-secret-do-not-display';
export type SandboxSetupState = {
  answer: number;
  consents: Electron.MessageBoxOptions[];
  owned: boolean;
  running: boolean;
  python: boolean;
  hold?: 'start' | 'install';
  held?: 'start' | 'install';
  failInstall: number;
  failStop: number;
  aborted: string[];
  commands: { args: string[]; owner: string; cleanup: boolean }[];
  requests: { path: string; method: string; body: unknown }[];
};
export type SandboxSetupHost = typeof globalThis & {
  sandboxSetup: { state: SandboxSetupState; release?: () => void };
};

export async function sandboxSetupFixture(
  directory: string,
  initial: Partial<Pick<SandboxSetupState, 'owned' | 'running' | 'python' | 'failInstall'>> = {},
) {
  const evidence = join(directory, 'sandbox-evidence.json');
  const entry = join(directory, 'sandbox-setup-entry.cjs');
  const owner = createHash('sha256').update(resolve(directory)).digest('hex').slice(0, 24);
  // Replace only Docker command execution, runtime HTTP, and discovery environment.
  // Keep the real manager, ownership checks, consent handler, service, renderer, and disk writes.
  await writeFile(
    entry,
    `
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const electron = require('electron');
const evidence = ${JSON.stringify(evidence)};
const expectedOwner = ${JSON.stringify(owner)};
const state = fs.existsSync(evidence) ? JSON.parse(fs.readFileSync(evidence, 'utf8')) : {
  answer: 1, consents: [], owned: false, running: false, python: false,
  failInstall: 0, failStop: 0, aborted: [], commands: [], requests: [],
  ...${JSON.stringify(initial)}
};
const fixture = globalThis.sandboxSetup = { state };
const save = () => fs.writeFileSync(evidence, JSON.stringify(state, null, 2));
const checkpoint = async (stage, signal) => {
  if (state.hold !== stage) return;
  state.held = stage;
  save();
  await new Promise((resolve, reject) => {
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', abort);
      delete fixture.release;
      delete state.held;
      if (error) state.aborted.push(stage);
      save();
      error ? reject(error) : resolve();
    };
    const abort = () => finish(new Error('Fixture sandbox operation cancelled'));
    fixture.release = () => finish();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
};
fixture.run = async (raw, options) => {
  const args = raw[0] === '--host' ? raw.slice(2) : raw;
  const owner = options.env.INTERVIEW_SANDBOX_OWNER;
  if (owner !== expectedOwner) throw new Error('Incorrect fixture owner');
  if (raw[0] === '--host' && raw[1] !== 'unix:///fixture/docker.sock') throw new Error('Unexpected Docker endpoint');
  state.commands.push({ args, owner, cleanup: !options.signal });
  save();
  if (args[0] === '--version') return 'Docker version 28';
  if (args[0] === 'context' && args[1] === 'show') return 'fixture-local';
  if (args[0] === 'context' && args[1] === 'inspect') return JSON.stringify('unix:///fixture/docker.sock');
  if (args[0] === 'info') return JSON.stringify({ OSType: 'linux', Architecture: 'x86_64', CgroupVersion: '2' });
  if (args[0] === 'compose' && args[1] === 'version') return '2.42.0';
  if (args[0] === 'ps') return state.owned ? ${JSON.stringify(sandboxContainerId)} : '';
  if (args[0] === 'inspect') return JSON.stringify([{
    Id: ${JSON.stringify(sandboxContainerId)},
    Config: {
      Image: ${JSON.stringify(PISTON_IMAGE)}, Env: ['PISTON_DISABLE_NETWORKING=true'],
      Labels: {
        'io.github.armandsyah.interview-workbench.owner': owner,
        'com.docker.compose.project': 'interview-workbench-' + owner,
        'com.docker.compose.service': 'piston'
      }
    },
    HostConfig: {
      Privileged: true, Memory: 2147483648, NanoCpus: 1500000000,
      PortBindings: { '2000/tcp': [{ HostIp: '127.0.0.1', HostPort: '2000' }] }
    },
    State: { Running: state.running }
  }]);
  if (args[0] === 'compose' && args.includes('up')) {
    if (!args.includes('interview-workbench-' + owner) || args.at(-1) !== 'piston') throw new Error('Unexpected compose target');
    await checkpoint('start', options.signal);
    state.owned = true;
    state.running = true;
    save();
    return '';
  }
  if (args[0] === 'stop') {
    if (JSON.stringify(args) !== JSON.stringify(['stop', '--time', '10', ${JSON.stringify(sandboxContainerId)}])) throw new Error('Unexpected stop target');
    if (state.failStop > 0) {
      state.failStop--;
      save();
      throw new Error(${JSON.stringify(sandboxRawError)});
    }
    state.running = false;
    save();
    return ${JSON.stringify(sandboxContainerId)};
  }
  throw new Error('Unexpected fixture Docker command: ' + JSON.stringify(args));
};
fixture.fetch = async (url, init = {}) => {
  const prefix = 'http://127.0.0.1:2000/api/v2/';
  if (!String(url).startsWith(prefix) || init.redirect !== 'error' || !init.signal) throw new Error('Unexpected fixture runtime request');
  const endpoint = String(url).slice(prefix.length);
  const body = init.body ? JSON.parse(init.body) : null;
  state.requests.push({ path: endpoint, method: init.method || 'GET', body });
  save();
  if (!state.running) throw new Error('Fixture sandbox is not listening');
  if (endpoint === 'runtimes') return Response.json(state.python ? [{ language: 'python', version: '3.12.0' }] : []);
  if (endpoint === 'packages') {
    if (!state.owned || init.method !== 'POST' || body.language !== 'python' || body.version !== '3.12.0') throw new Error('Unexpected fixture package request');
    await checkpoint('install', init.signal);
    if (state.failInstall > 0) {
      state.failInstall--;
      save();
      throw new Error(${JSON.stringify(sandboxRawError)});
    }
    state.python = true;
    save();
    return Response.json({ language: 'python', version: '3.12.0' });
  }
  if (endpoint === 'execute') {
    if (init.method !== 'POST' || body.language !== 'python' || body.version !== '3.12.0' || body.files?.length !== 1 || body.files[0].name !== 'health.py' || body.files[0].content !== "print('interview-sandbox-ready')") throw new Error('Only the sandbox health check is permitted');
    return Response.json({ run: { code: 0, stdout: 'interview-sandbox-ready\\n', signal: null } });
  }
  throw new Error('Unexpected fixture runtime endpoint: ' + endpoint);
};
electron.dialog.showMessageBox = async (_window, options) => {
  if (options.title !== 'Enable local code execution?') throw new Error('Unexpected fixture native dialog');
  state.consents.push(options);
  save();
  return { response: state.answer, checkboxChecked: false };
};
const original = ${JSON.stringify(resolve('dist/main/index.cjs'))};
let source = fs.readFileSync(original, 'utf8');
for (const [marker, replacement] of ${JSON.stringify([
      ['this.run = options.run ?? runDocker;', 'this.run = globalThis.sandboxSetup.run;'],
      ['this.request = options.fetch ?? fetch;', 'this.request = globalThis.sandboxSetup.fetch;'],
      ['this.env = options.env ?? process.env;', 'this.env = { PATH: process.env.PATH };'],
    ])}) {
  if (source.split(marker).length !== 2) throw new Error('Expected one sandbox boundary marker: ' + marker);
  source = source.replace(marker, () => replacement);
}
save();
const loaded = new Module(original, module);
loaded.filename = original;
loaded.paths = Module._nodeModulePaths(path.dirname(original));
loaded._compile(source, original);
`,
  );
  return { entry, evidence };
}
