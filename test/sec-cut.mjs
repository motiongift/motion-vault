// Security audit 2026-11-04 (pass 1): run REAL declarations of src/webEngine.ts in node.
// webEngine.ts needs browser globals and cannot be imported, so this cuts the named top-level declarations (functions,
// consts) and `engine.<prop>` members out of the source with the TypeScript compiler API, transpiles them to JS and
// evaluates them with the stubs a test hands in. What runs is the code of the file, byte for byte (minus types).
import ts from 'typescript';
import { readFileSync } from 'node:fs';

const SRC = new URL('../src/webEngine.ts', import.meta.url);
export const source = () => readFileSync(SRC, 'utf8');

function find(sf, name) {
  if (name.startsWith('engine.')) {
    const prop = name.slice('engine.'.length);
    let out = null;
    const visit = (n) => {
      if (out) return;
      if (ts.isVariableDeclaration(n) && n.name.getText(sf) === 'engine' && n.initializer && ts.isObjectLiteralExpression(n.initializer)) {
        for (const p of n.initializer.properties) if (p.name && p.name.getText(sf) === prop) { out = `const ${prop.replace(/\W/g, '_')} = ${ts.isPropertyAssignment(p) ? p.initializer.getText(sf) : p.getText(sf)};`; return; }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
  }
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === name) return st.getText(sf);
    if (ts.isVariableStatement(st) && st.declarationList.declarations.some((d) => d.name.getText(sf) === name)) return st.getText(sf);
  }
  return null;
}

/** Cut `names` out of webEngine.ts (or `text`), transpile, evaluate with `stubs` in scope; returns { name: value }. */
export function cut(names, stubs = {}, text = source()) {
  const sf = ts.createSourceFile('webEngine.ts', text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const parts = names.map((n) => { const t = find(sf, n); if (!t) throw new Error('not found in webEngine.ts: ' + n); return t; });
  const js = ts.transpileModule(parts.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/^export /gm, '');
  const ids = names.map((n) => (n.startsWith('engine.') ? n.slice(7).replace(/\W/g, '_') : n));
  const keys = Object.keys(stubs);
  // eslint-disable-next-line no-new-func
  return new Function(...keys, `${js}\nreturn { ${ids.join(', ')} };`)(...keys.map((k) => stubs[k]));
}
