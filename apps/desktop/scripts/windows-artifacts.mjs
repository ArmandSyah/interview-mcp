import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const directory = resolve(process.argv[2] || 'release');
const installers = (await readdir(directory, { withFileTypes: true })).filter(
  (entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'),
);
if (installers.length !== 1)
  throw new Error(`Expected one Windows installer, got ${installers.length}`);
const name = installers[0].name;
const installer = join(directory, name);
const sha256 = createHash('sha256')
  .update(await readFile(installer))
  .digest('hex');
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const sourceCommit = process.env.GITHUB_SHA || null;
if (sourceCommit !== null && !/^[0-9a-f]{40}$/i.test(sourceCommit))
  throw new Error('GITHUB_SHA must identify a source commit');
await writeFile(join(directory, 'SHA256SUMS.txt'), `${sha256}  ${name}\n`);
await writeFile(
  join(directory, 'build-info.json'),
  JSON.stringify(
    {
      version,
      sourceCommit,
      workflowRun: process.env.GITHUB_RUN_ID || null,
      platform: 'windows',
      architecture: 'x64',
      installer: name,
      bytes: (await stat(installer)).size,
      sha256,
      publisherSigned: false,
      channel: 'development-preview',
    },
    null,
    2,
  ) + '\n',
);
const guide = await readFile('../../docs/windows-install.md', 'utf8');
const base = `https://github.com/ArmandSyah/interview-mcp/blob/${sourceCommit || 'feat/interview-desktop'}/docs/windows-install.md`;
const standalone = guide.replace(
  /\]\((\.\.?\/[^)]+)\)/g,
  (_match, target) => `](${new URL(target, base).href})`,
);
await writeFile(join(directory, 'INSTALL-WINDOWS.md'), standalone);
