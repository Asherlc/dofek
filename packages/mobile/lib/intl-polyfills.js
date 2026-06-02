if (typeof Intl.getCanonicalLocales !== "function") {
  require("@formatjs/intl-getcanonicallocales/polyfill-force.js");
}

if (typeof Intl.Locale !== "function") {
  require("@formatjs/intl-locale/polyfill-force.js");
}

if (typeof Intl.PluralRules !== "function") {
  require("@formatjs/intl-pluralrules/polyfill-force.js");
  require("@formatjs/intl-pluralrules/locale-data/en.js");
}

if (typeof Intl.NumberFormat.prototype.formatToParts !== "function") {
  require("@formatjs/intl-numberformat/polyfill-force.js");
  require("@formatjs/intl-numberformat/locale-data/en.js");
}
