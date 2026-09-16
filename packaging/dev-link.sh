#!/usr/bin/env bash
# Point this machine's claude-brain at a working copy instead of the installed package.
#
# The package installs the server to /usr/share/claude-brain and the CLI to
# /usr/bin/claude-brain, and the user service starts the first of those. While a feature is
# being written that means every change needs a package build, an install and a restart
# before it can be looked at — which is slow enough that it gets skipped, which is how a
# release ends up being the first thing that ever ran the new code.
#
# This swaps both ends for the checkout:
#
#   the daemon   a systemd drop-in overriding ExecStart to run `bun --watch server.ts` from
#                here, so saving a file restarts the server by itself
#   the CLI      ~/.local/bin/claude-brain, which is earlier in PATH than /usr/bin
#
# Nothing the package owns is touched, so `pacman -Syu` still works and `--remove` puts
# everything back by deleting two files it created.
#
#   packaging/dev-link.sh            link this checkout
#   packaging/dev-link.sh --remove   go back to the installed package
#
# The data directory is NOT changed: the checkout runs against the same vault, the same
# index and the same design library as the package did. That is the point — it is the real
# brain, being developed — but it does mean a schema migration written here is applied to
# real data, so migrations stay additive.

set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/claude-brain.service.d"
drop_in="$unit_dir/10-dev.conf"
shim="$HOME/.local/bin/claude-brain"

restart_daemon() {
	systemctl --user daemon-reload
	if systemctl --user is-enabled claude-brain.service >/dev/null 2>&1; then
		systemctl --user restart claude-brain.service
	fi
}

if [[ "${1:-}" == "--remove" ]]; then
	rm -f "$drop_in" "$shim"
	rmdir "$unit_dir" 2>/dev/null || true
	restart_daemon
	echo "unlinked — claude-brain is the installed package again"
	systemctl --user show claude-brain.service -p ExecStart --value 2>/dev/null || true
	exit 0
fi

if [[ ! -f "$repo/server.ts" ]]; then
	echo "no server.ts in $repo — run this from a claude-brain checkout" >&2
	exit 1
fi

bun="$(command -v bun || echo /usr/bin/bun)"
if [[ ! -x "$bun" ]]; then
	echo "bun is not installed" >&2
	exit 1
fi

if [[ ! -d "$repo/node_modules" ]]; then
	echo "installing dependencies in $repo"
	(cd "$repo" && "$bun" install)
fi

mkdir -p "$unit_dir" "$(dirname "$shim")"

# ExecStart= on its own clears the packaged value; systemd otherwise appends and refuses
# the unit for having two ExecStart lines in a Type=simple service.
cat >"$drop_in" <<EOF
# Written by packaging/dev-link.sh. Delete this file (or run dev-link.sh --remove) to go
# back to the installed package.
[Service]
ExecStart=
ExecStart=$bun --watch $repo/server.ts
WorkingDirectory=$repo
Environment=CLAUDE_BRAIN_DEV=1
EOF

cat >"$shim" <<EOF
#!/usr/bin/env bash
# Written by packaging/dev-link.sh — runs the working copy at $repo.
exec "$bun" "$repo/bin/claude-brain.ts" "\$@"
EOF
chmod +x "$shim"

restart_daemon

echo "linked:"
echo "  daemon  $(systemctl --user show claude-brain.service -p ExecStart --value 2>/dev/null | sed 's/.*argv\[\]=//; s/ ;.*//')"
echo "  cli     $shim -> $repo/bin/claude-brain.ts"
echo
echo "the server now restarts by itself when a file here changes."
case ":$PATH:" in
	*":$HOME/.local/bin:"*) ;;
	*) echo "warning: $HOME/.local/bin is not on PATH, so \`claude-brain\` still runs the packaged CLI" >&2 ;;
esac
