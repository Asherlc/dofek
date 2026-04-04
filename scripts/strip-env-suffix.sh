#!/bin/sh
# Strip the _unencrypted suffix from SOPS env var names.
#
# SOPS leaves values with key names ending in _unencrypted as plaintext.
# This script normalises the env so app code can read the canonical name
# (e.g. SENTRY_DSN) without caring about the SOPS convention.
#
# For each FOO_unencrypted var, export FOO with the same value unless
# FOO is already set (encrypted value takes precedence).
#
# Usage: source this script before running the app, or use it as a wrapper:
#   . ./scripts/strip-env-suffix.sh          # source mode
#   ./scripts/strip-env-suffix.sh command    # wrapper mode (execs command)

for var in $(printenv | sed -n 's/^\([A-Za-z_][A-Za-z_0-9]*\)_unencrypted=.*/\1/p'); do
  eval "[ -z \"\${$var}\" ] && export $var=\"\${${var}_unencrypted}\""
done

# If called with arguments, exec them; otherwise return to caller (source mode).
if [ $# -gt 0 ]; then
  exec "$@"
fi
