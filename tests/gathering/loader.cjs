const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
function load(file, mocks = {}, globals = {}) {
  const exports = {};
  const compiled = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText;
  const fallback = new Proxy({}, { get: (_, key) => key === '__esModule' ? true : key === 'then' ? undefined : () => undefined });
  const context = { exports, module: { exports }, require(name) {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name === './gathering-policy') return load('lib/gathering-policy.ts', mocks, globals);
    if (name === './abort-utils') return { throwIfAborted: signal => signal?.throwIfAborted(), isAbortError: e => e?.name === 'AbortError' };
    return fallback;
  }, console, AbortController, Event, EventTarget, CustomEvent, setTimeout, clearTimeout, URL, ...globals };
  vm.runInNewContext(compiled, context, { filename: file });
  return context.module.exports;
}
const flush = async () => { for(let i=0;i<25;i++) await Promise.resolve(); };
module.exports = { load, flush };
