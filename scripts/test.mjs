import { mkdtemp, readdir, readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

const root = process.cwd();
const out = await mkdtemp(path.join(tmpdir(), 'looma-tests-'));
async function compile(relative) {
  let entries;
  try { entries = await readdir(path.join(root, relative), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  await mkdir(path.join(out, relative), { recursive: true });
  for (const entry of entries) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) { await compile(name); continue; }
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      const result = ts.transpileModule(await readFile(path.join(root, name), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
        fileName: name,
      });
      await writeFile(path.join(out, name.replace(/\.ts$/, '.js')), result.outputText);
    } else if (entry.name.endsWith('.cjs') || entry.name.endsWith('.mjs')) {
      await cp(path.join(root, name), path.join(out, name));
    }
  }
}
try {
  await writeFile(path.join(out, 'package.json'), '{"type":"commonjs"}');
  await compile('src');
  await compile('tests');
  await compile('electron');
  await compile('shared');
  const files = (await readdir(path.join(out, 'tests'))).filter(name => /\.test\.(js|cjs)$/.test(name));
  const result = spawnSync(process.execPath, ['--test', ...files.map(name => path.join(out, 'tests', name))], {
    cwd: root, stdio: 'inherit', env: { ...process.env, NODE_PATH: path.join(root, 'node_modules') },
  });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(out, { recursive: true, force: true });
}
