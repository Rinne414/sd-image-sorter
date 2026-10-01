// Runs the REAL frontend status-text builders and formatUserError under node.
//   node frontend_status_text_harness.cjs <lang> <json: [{fn, progress}, ...]>
// Prints a JSON array with, per case, the built `text` and what the real
// formatUserError would have turned the same raw sentence into (`formatted`).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..', 'frontend', 'js');
const lang = process.argv[2];
const cases = JSON.parse(process.argv[3]);

const sandbox = { console, Set, Map, Object, String, Number, Array, JSON, Math, Date, Error, RegExp };
sandbox.window = sandbox;
sandbox.document = {
  addEventListener() {},
  getElementById() { return null; },
  querySelector() { return null; },
  documentElement: { lang },
};
vm.createContext(sandbox);

function load(file) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
}

load(lang === 'zh-CN' ? 'lang/zh-CN.js' : 'lang/en.js');
const table = sandbox.I18nLang_zhCN || sandbox.I18nLang_en;
sandbox.I18n = {
  getLang: () => lang,
  t: (key) => (Object.prototype.hasOwnProperty.call(table, key) ? table[key] : key),
};
for (const file of [
  'modules/utils/errors.js',
  'app/constants-prefs.js',
  'app/scan-progress-lifecycle.js',
  'app/tagging-flow.js',
]) {
  try {
    load(file);
  } catch (error) {
    // Top-level DOM wiring of a script is irrelevant here; its function declarations are hoisted.
    if (!/is not defined|Cannot read/.test(String(error))) throw error;
  }
}

const out = cases.map(({ fn, progress, raw }) => ({
  text: vm.runInContext(`${fn}(${JSON.stringify(progress)})`, sandbox),
  formatted: raw ? vm.runInContext(`formatUserError(${JSON.stringify(raw)})`, sandbox) : null,
}));
process.stdout.write(JSON.stringify(out));
