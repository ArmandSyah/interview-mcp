import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve('../..');
const result = spawnSync(
  'uv',
  [
    'run',
    '--with',
    'pyinstaller',
    'pyinstaller',
    '--noconfirm',
    '--clean',
    '--distpath',
    resolve('.'),
    '--workpath',
    resolve(root, 'build/desktop'),
    resolve('backend.spec'),
  ],
  { cwd: root, stdio: 'inherit' },
);
process.exit(result.status ?? 1);
