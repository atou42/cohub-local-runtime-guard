import { existsSync, appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Run upstream tests against the reviewed installed payload, including its SDK
// and transitive runtime imports, instead of silently testing checkout sources.
const cli = process.env.COHUB_RECONNECT_CLI;
if (!cli || !path.isAbsolute(cli)) throw new Error('COHUB_RECONNECT_CLI must be an absolute package directory');
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@opentelemetry/api' && process.env.COHUB_RECONNECT_TEST_DEPS) {
    const require = createRequire(path.join(process.env.COHUB_RECONNECT_TEST_DEPS, 'package.json'));
    return nextResolve(pathToFileURL(require.resolve(specifier)).href, context);
  }
  if (specifier === '@cohub/infra/logging' && process.env.COHUB_RECONNECT_REFERENCE) {
    const source = path.join(process.env.COHUB_RECONNECT_REFERENCE, 'packages/infra/src/logging/index.ts');
    return nextResolve(pathToFileURL(source).href, context);
  }
  let source;
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) source = new URL(specifier, context.parentURL);
  else if (specifier.startsWith('file:')) source = new URL(specifier);
  if (source) {
    const marker = '/packages/cli/src/';
    const pathname = fileURLToPath(source);
    const offset = pathname.lastIndexOf(marker);
    if (offset !== -1) {
      const relative = pathname.slice(offset + marker.length).replace(/\.ts$/, '.js');
      const target = path.join(cli, 'dist', relative);
      if (!existsSync(target)) throw new Error(`Installed CLI module missing: ${relative}`);
      if (process.env.COHUB_RECONNECT_IMPORT_AUDIT)
        appendFileSync(process.env.COHUB_RECONNECT_IMPORT_AUDIT, `${target}\n`);
      return { url: pathToFileURL(target).href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (url.endsWith('/packages/cli/tests/fixtures/runtime-native.ts') && result.source) {
    // Upstream uses URL.pathname as a shell path; decode only this fixture path
    // so its fake executables work in checkouts containing non-ASCII characters.
    const source = String(result.source);
    const fixed = source.replace(/new URL\((`\.\/runtime-\$\{harness\}\.mjs`,\s*import\.meta\.url)\)\.pathname/g,
      (_, args) => `cohubFixtureFilePath(new URL(${args}))`);
    if (fixed === source) throw new Error('Upstream fixture path shim no longer matches; review it');
    return { ...result, source: `import { fileURLToPath as cohubFixtureFilePath } from 'node:url';\n${fixed}` };
  }
  return result;
}
