require("@formatjs/intl-getcanonicallocales/polyfill.js");
require("@formatjs/intl-locale/polyfill.js");

if (typeof Intl.PluralRules !== "function") {
  require("@formatjs/intl-pluralrules/polyfill-force.js");
  require("@formatjs/intl-pluralrules/locale-data/en.js");
}

if (typeof Intl.NumberFormat.prototype.formatToParts !== "function") {
  require("@formatjs/intl-numberformat/polyfill-force.js");
  require("@formatjs/intl-numberformat/locale-data/en.js");
}
