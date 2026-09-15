#!/bin/sh
# Produce the AUR source tarball for a tagged release and stamp its checksum into the
# PKGBUILD. Always from the tag, never from the working tree: the tree carries 300+ MB of
# gitignored node_modules and a locally built public/bundle.js, none of which belongs in
# a source tarball.
#
# The untracked check exists because `git archive` silently omits untracked files. A new
# src/*.ts that was never `git add`ed would produce a tarball that builds on the author's
# machine and fails for everyone else.
set -eu

pkgver="${1:?usage: mktarball.sh <version>   e.g. mktarball.sh 0.3.0}"
cd "$(dirname "$0")/.."

git diff-index --quiet HEAD -- || {
	echo "working tree is dirty — commit before releasing" >&2
	exit 1
}

untracked=$(git ls-files --others --exclude-standard -- src bin frontend packaging test server.ts)
[ -z "$untracked" ] || {
	echo "untracked sources would be silently omitted from the tarball:" >&2
	echo "$untracked" >&2
	exit 1
}

git rev-parse -q --verify "v$pkgver" >/dev/null || {
	echo "no tag v$pkgver — tag the release first" >&2
	exit 1
}

out="claude-brain-$pkgver.tar.gz"
git archive --format=tar.gz --prefix="claude-brain-$pkgver/" "v$pkgver" -o "$out"

# The checksum has to be of the file makepkg will fetch, not of the one just built here.
# Both hold the same tree, but the forge gzips its tag archives at its own level, so the
# bytes differ and a locally computed sum fails on every user's machine. Fetch what the
# PKGBUILD's source= points at, check that it really is this tree, and sum the download.
#
# This URL is the one line here that has to agree with the PKGBUILD by hand. The check
# below is what catches it if they ever stop agreeing.
source_url="$(sed -n 's/^url="\(.*\)"$/\1/p' packaging/PKGBUILD)/archive/refs/tags/v$pkgver.tar.gz"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL --retry 3 --retry-delay 3 -o "$work/published.tar.gz" "$source_url" || {
	echo "could not fetch $source_url" >&2
	echo "push the tag first, then rerun" >&2
	exit 1
}

mkdir -p "$work/published" "$work/local"
tar xzf "$work/published.tar.gz" -C "$work/published"
tar xzf "$out" -C "$work/local"
diff -r "$work/published/claude-brain-$pkgver" "$work/local/claude-brain-$pkgver" >/dev/null || {
	echo "the published tag is not this tree — did the tag move after it was pushed?" >&2
	exit 1
}

sum=$(sha256sum "$work/published.tar.gz" | cut -d' ' -f1)
sed -i "s/^sha256sums=.*/sha256sums=('$sum')/" packaging/PKGBUILD

echo "$out"
echo "sha256 $sum  (of the published tag archive, written into packaging/PKGBUILD)"
echo
echo "next: copy packaging/PKGBUILD into the AUR checkout,"
echo "      regenerate .SRCINFO with 'makepkg --printsrcinfo > .SRCINFO', commit, push."
