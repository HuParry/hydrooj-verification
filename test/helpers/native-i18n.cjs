'use strict';

const fs = require('node:fs');
const nativeSource = require('./native-sources.cjs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

// Run Hydro's actual locale lookup/fallback implementation. Only its Cordis
// service shell is replaced; no database, HTTP server or SMTP transport starts.
module.exports = function nativeI18n() {
  const source = fs.readFileSync(nativeSource('hydrooj/src/lib/i18n.ts'), 'utf8');
  const code = transformSync(source, { loader: 'ts', format: 'cjs', target: 'node22' }).code;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports,
    global: { Hydro: {} },
    require: name => {
      if (name !== '../context') throw new Error('Unexpected native i18n dependency: ' + name);
      return { Service: class { constructor(ctx) { this.ctx = ctx; } } };
    },
  }, { filename: 'native-hydro-i18n.js' });
  const service = new module.exports.I18nService({ effect: callback => callback(), emit() {} });
  require('../../locales')({ i18n: service });
  return service;
};
