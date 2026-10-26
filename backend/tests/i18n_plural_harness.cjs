// Loads the REAL frontend/js/i18n.js and language packs under node.
//   node i18n_plural_harness.cjs data
//     -> {rules, en, zh}: the singular lists and both packs
//   node i18n_plural_harness.cjs format '<json: [{template, params}, ...]>'
//     -> what I18n.format writes for each case
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..', 'frontend', 'js');
const sandbox = { console, Object, String, Number, Array, JSON, Math, RegExp, Error };
sandbox.window = sandbox;
sandbox.document = {
  addEventListener() {},
  querySelectorAll() { return []; },
  documentElement: { lang: 'en', classList: { add() {}, remove() {}, toggle() {} } },
};
vm.createContext(sandbox);
for (const file of ['lang/en.js', 'lang/zh-CN.js', 'i18n.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
}

const { I18n } = sandbox;
if (process.argv[2] === 'data') {
  const { PLURALS, MODIFIERS, VERBS } = I18n.pluralRules;
  process.stdout.write(JSON.stringify({
    rules: { PLURALS, MODIFIERS: [...MODIFIERS], VERBS },
    en: sandbox.I18nLang_en,
    zh: sandbox.I18nLang_zhCN,
  }));
} else {
  const cases = JSON.parse(process.argv[3]);
  process.stdout.write(JSON.stringify(cases.map(({ template, params }) => I18n.format(template, params))));
}
