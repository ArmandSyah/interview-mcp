import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

// Conservative inventory: include the published license files of all runtime deps,
// even when the bundler tree-shakes a package. Font notices are tracked separately.
const root = resolve('.');
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const notices = [];
const missing = [];
const uninstalledOptional = [];
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path.startsWith('node_modules/') || entry.dev) continue;
  const directory = join(root, path);
  let pkg;
  try {
    pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  } catch (error) {
    // npm records optional binaries for every platform in the lockfile, but only
    // installs those compatible with this build host. They cannot be bundled.
    if (entry.optional && error.code === 'ENOENT') {
      uninstalledOptional.push(path);
      continue;
    }
    throw error;
  }
  const files = (await readdir(directory, { withFileTypes: true })).filter(
    (file) => file.isFile() && /^(license|licence|copying|notice)(\.|$)/i.test(file.name),
  );
  const texts = await Promise.all(
    files.map(
      async (file) => `${file.name}\n${await readFile(join(directory, file.name), 'utf8')}`,
    ),
  );
  if (!texts.length && pkg.name !== '@excalidraw/excalidraw') missing.push(pkg.name);
  notices.push(
    `${pkg.name}@${pkg.version}\nSPDX metadata: ${JSON.stringify(pkg.license ?? 'not declared')}\n${texts.join('\n\n') || 'No separate license file in the published package. Excalidraw notices are in notices.txt.'}`,
  );
}
const output = join(root, 'dist/renderer/third-party');
await mkdir(output, { recursive: true });
await writeFile(
  join(output, 'dependency-notices.txt'),
  notices.join('\n\n============================================================\n\n'),
);
await writeFile(
  join(output, 'PROJECT-LICENSE.txt'),
  await readFile(resolve(root, '../../LICENSE'), 'utf8'),
);
await writeFile(
  join(output, 'license-inventory.json'),
  JSON.stringify(
    { missingPublishedNotices: missing, uninstalledOptionalPackages: uninstalledOptional },
    null,
    2,
  ),
);
console.log(
  `Collected dependency notices; ${missing.length} published packages have metadata but no separate notice file.`,
);
