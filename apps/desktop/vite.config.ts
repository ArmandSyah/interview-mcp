import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fontRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'node_modules/@excalidraw/excalidraw/dist/prod/fonts',
);
async function fontFiles(path = fontRoot): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory() ? fontFiles(join(path, entry.name)) : [join(path, entry.name)],
      ),
    )
  ).flat();
}

export default defineConfig(({ command }) => ({
  base: './',
  plugins: [
    react(),
    {
      name: 'offline-excalidraw-fonts',
      enforce: 'pre',
      transform(code, id) {
        if (
          !id.replaceAll('\\', '/').includes('/@excalidraw/excalidraw/') ||
          !code.includes('ASSETS_FALLBACK_URL')
        )
          return;
        // 0.18.1 adds an unconditional CDN fallback/preload even with ASSET_PATH set.
        // Keep that fallback local too; fail closed if an SDK upgrade changes this shape.
        const fallback =
          /(["']ASSETS_FALLBACK_URL["']\s*,\s*)`https:\/\/esm\.sh\/[\s\S]*?\/dist\/prod\/`/g;
        const updated = code.replace(fallback, '$1new URL("./", window.location.href).href');
        if (updated === code)
          this.error('Excalidraw font fallback changed; re-audit offline font loading');
        // Liberation Sans is server-only in the SDK and is not used by this browser workbench.
        const browserOnly = updated.replace(
          /\b[\w$]+\("Liberation Sans",\s*\.\.\.[\w$]+\)[,;]?/g,
          '',
        );
        if (browserOnly === updated)
          this.error('Excalidraw server-only font registration changed; re-audit font bundling');
        return { code: browserOnly, map: null };
      },
      async buildStart() {
        if (command !== 'build') return;
        for (const path of await fontFiles())
          if (!relative(fontRoot, path).startsWith('Liberation'))
            this.emitFile({
              type: 'asset',
              fileName: 'fonts/' + relative(fontRoot, path).replaceAll('\\', '/'),
              source: await readFile(path),
            });
        this.emitFile({
          type: 'asset',
          fileName: 'third-party/notices.txt',
          source: await readFile(new URL('./licenses/notices.txt', import.meta.url)),
        });
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (!request.url?.startsWith('/fonts/')) return next();
          try {
            const path = resolve(
              fontRoot,
              decodeURIComponent(new URL(request.url, 'http://localhost').pathname.slice(7)),
            );
            if (relative(fontRoot, path).startsWith('..')) return next();
            response.setHeader(
              'Content-Type',
              path.endsWith('.woff2') ? 'font/woff2' : 'text/plain',
            );
            response.end(await readFile(path));
          } catch {
            next();
          }
        });
      },
    },
    {
      name: 'development-csp',
      transformIndexHtml: (html) =>
        command === 'serve'
          ? html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';")
          : html,
    },
  ],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  optimizeDeps: {
    exclude: ['@excalidraw/excalidraw'],
    // Keep the canvas source available for the offline font transform. Optimize
    // its browser dependencies, including their nested CommonJS imports.
    include: [
      '@braintree/sanitize-url',
      '@excalidraw/laser-pointer',
      '@excalidraw/mermaid-to-excalidraw',
      '@radix-ui/react-popover',
      '@radix-ui/react-tabs',
      'browser-fs-access',
      'canvas-roundrect-polyfill',
      'clsx',
      'es6-promise-pool',
      'fractional-indexing',
      'fuzzy',
      'image-blob-reduce',
      'jotai',
      'jotai-scope',
      'lodash.debounce',
      'lodash.throttle',
      'nanoid',
      'pako',
      'perfect-freehand',
      'pica',
      'png-chunk-text',
      'png-chunks-encode',
      'png-chunks-extract',
      'points-on-curve',
      'roughjs/bin/generator',
      'roughjs/bin/math',
      'roughjs/bin/rough',
      'tunnel-rat',
    ].map((dependency) => `@excalidraw/excalidraw > ${dependency}`),
  },
  build: { outDir: 'dist/renderer', emptyOutDir: true },
}));
