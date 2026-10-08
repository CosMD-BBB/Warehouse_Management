#!/bin/bash
# Operator-only replacement of one store's accounts while retaining its data.
set -u
ACCOUNTS_ROOT="$(cd -- "$(dirname -- "$0")" && pwd -P)" || exit 1
exec /bin/bash "$ACCOUNTS_ROOT/Recover Order Hub.command" --replace-accounts "$@"
