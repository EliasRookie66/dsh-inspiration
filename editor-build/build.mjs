import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const workspace = dirname(fileURLToPath(new URL('../continuous-markdown.js', import.meta.url)));
const nodeModules = fileURLToPath(new URL('./node_modules/', import.meta.url));
export const pinnedBuildOptions = { absWorkingDir: workspace, bundle: true, nodePaths: [nodeModules], write: false };

export async function buildEngine() {
  const { outputFiles, metafile } = await build({
    ...pinnedBuildOptions, entryPoints: ['editor-build/entry.js'], metafile: true,
    format: 'iife', globalName: '__dshInspirationContinuousMarkdown', platform: 'browser', target: 'es2022',
    minify: true, sourcemap: false, legalComments: 'inline', charset: 'utf8',
  });
  const lock = JSON.parse(await readFile(join(workspace, 'editor-build/package-lock.json'), 'utf8'));
  const packages = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const parts = input.split('/node_modules/').at(-1).split('/');
    if (!input.includes('/node_modules/')) continue;
    packages.add(parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
  }
  const licenses = [];
  for (const name of [...packages].sort()) {
    const dir = join(nodeModules, name);
    const file = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'].find(candidate => existsSync(join(dir, candidate)));
    const version = lock.packages['node_modules/' + name]?.version;
    if (!file || !version) throw new Error('Missing pinned version or license for ' + name);
    const license = (await readFile(join(dir, file), 'utf8')).trim().replace(/\r\n?/g, '\n');
    licenses.push(name + '@' + version + '\n' + license.replaceAll('*/', '* /'));
  }
  // The notices travel with the IIFE into the ModuleLoader artifact, without a
  // second file that the packager or browser would need to locate at runtime.
  return '/*! DSH inspiration editor; third-party notices follow.\n\n' + licenses.join('\n\n---\n\n') + '\n*/\n' + outputFiles[0].text;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length > 3 || ['--help', '-h'].includes(process.argv[2])) {
    process.stderr.write('Usage: node editor-build/build.mjs [outfile|--stdout]\n');
    process.exitCode = 1;
  } else {
    const artifact = await buildEngine(), destination = process.argv[2];
    if (destination && destination !== '--stdout') await writeFile(resolve(destination), artifact, 'utf8');
    else process.stdout.write(artifact);
  }
}
