import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname, relative, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function checkImports(sources, modules) {
  const byId = new Map(modules.map(module => [module.id, module]));
  if (byId.size !== modules.length) throw Error('duplicate_module');
  function walkGraph(id, stack = []) {
    if (stack.includes(id)) throw Error('module_cycle');
    const module = byId.get(id);
    if (!module) throw Error('unknown_dependency');
    for (const target of module.imports) walkGraph(target, [...stack, id]);
  }
  for (const id of byId.keys()) walkGraph(id);
  const owner = path => {
    const matches = modules.filter(module => module.path.endsWith('/') ? path.startsWith(module.path) : path === module.path);
    if (matches.length !== 1) throw Error('unowned_or_ambiguous_source: ' + path);
    return matches[0];
  };
  let imports = 0;
  for (const [file, source] of Object.entries(sources)) {
    const module = owner(file);
    // This is a dependency lint, not a sandbox. Executable plugins are not loaded.
    if (/\b(?:import|require)\s*\(|\b(?:eval|Function)\s*\(|\bfetch\s*\(|\bprocess\.env\b/.test(source)) {
      throw Error('dynamic_or_external_access: ' + file);
    }
    for (const match of source.matchAll(/(?:import|export)\s+(?:[^;'"]*?\s+from\s*)?['"]([^'"]+)['"]/g)) {
      imports++;
      const specifier = match[1];
      if (specifier.startsWith('node:')) {
        if (!module.builtins.includes(specifier)) throw Error('forbidden_builtin: ' + file);
        continue;
      }
      if (!specifier.startsWith('.')) throw Error('undeclared_external_dependency: ' + file);
      const target = posix.normalize(posix.join(posix.dirname(file), specifier));
      if (!Object.hasOwn(sources, target)) throw Error('missing_import: ' + target);
      const targetOwner = owner(target);
      if (targetOwner.id !== module.id &&
          (!module.imports.includes(targetOwner.id) || target !== targetOwner.path + 'index.mjs')) {
        throw Error('private_or_forbidden_module_import: ' + file + ' -> ' + target);
      }
    }
  }
  return { sourceFiles: Object.keys(sources).length, imports, modules: modules.length };
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const manifest = JSON.parse(await readFile(resolve(root, 'modules.json'), 'utf8'));
  const sources = {};
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw Error('source_symlink');
      if (entry.isDirectory()) await visit(path);
      else if (entry.name.endsWith('.mjs')) sources[relative(root, path).replaceAll('\\', '/')] = await readFile(path, 'utf8');
    }
  }
  await visit(resolve(root, 'src'));
  console.log(JSON.stringify(checkImports(sources, manifest.modules)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
