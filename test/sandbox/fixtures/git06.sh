#!/bin/sh
# GUEST ONLY. Exercise real Git through the exposed workspace filesystem.
set -efu
case "$(pwd -P)" in /workspace/*) ;; *) echo '06: guest workspace required' >&2; exit 1;; esac
# Preserve this unique repository for reboot inspection; never remove unknown data.
directory=$(mktemp -d ./git06-XXXXXXXX)
printf '06 Git repository: %s\n' "$directory"
cd "$directory"
git init -q
git config user.name 'Factory06 fixture'
git config user.email 'factory06@example.invalid'
git config commit.gpgsign false
printf 'factory06 committed content\n' > tracked.txt
git add tracked.txt
git commit -qm '06 fixture baseline'
before=$(git rev-parse HEAD)
# Real exclusive index lock must prevent a concurrent index mutation.
printf 'owned fixture lock\n' > .git/index.lock
if git add tracked.txt 2>lock-diagnostic.txt; then
  echo '06: Git ignored existing index lock' >&2
  exit 1
fi
grep 'index.lock' lock-diagnostic.txt >/dev/null
test "$(cat .git/index.lock)" = 'owned fixture lock'
rm .git/index.lock
git mv tracked.txt renamed.txt
chmod +x renamed.txt
git add renamed.txt
git commit -qm '06 rename and executable metadata'
test "$(git show HEAD:renamed.txt)" = 'factory06 committed content'
test "$(git ls-files -s renamed.txt | cut -d ' ' -f 1)" = 100755
test "$(git rev-parse HEAD^)" = "$before"
git fsck --full
printf '06 Git FUSE assertions passed; preserve repo and compare OIDs after reboot\n'
git rev-parse HEAD
