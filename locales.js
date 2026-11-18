'use strict';

// Use Hydro's own language resolution. These are its four bundled UI locales;
// regional variants (zh-CN, zh-TW, ko-KR, en-US) fall back through Hydro itself.
const dictionaries = {
  en: require('./locales/en.json'),
  zh: require('./locales/zh.json'),
  zh_TW: require('./locales/zh_TW.json'),
  ko: require('./locales/ko.json'),
};

module.exports = (ctx) => {
  for (const [language, dictionary] of Object.entries(dictionaries)) {
    ctx.i18n.load(language, dictionary);
  }
};
