#!/usr/bin/env bash
# A shell fixture, as shfmt -i 2 formats it.
set -euo pipefail

greet() {
  echo "hello, $1"
}

function cleanup {
  rm -rf "$tmp"
}

if [ -n "${1:-}" ]; then
  echo one
# the second
elif [[ $x == y ]]; then
  echo two
else
  echo three
fi

for f in a b c; do
  if true; then
    echo "$f"
  fi
done

while read -r line; do
  echo "$line"
done <file

until false; do break; done

case "$1" in
start)
  echo start
  ;;
stop | halt)
  echo stop
  ;;
*)
  echo "usage" >&2
  exit 2
  ;;
esac

cat <<END
  a heredoc
    its blanks kept
END

cat <<-'END'
	tabbed
	END

x=$(
  echo nested
)

arr=(
  one
  two
)

long_command --with-an-option \
  --and-another \
  --and-a-third

a && b ||
  c

echo one |
  grep o |
  wc -l

a |
  b |
  c || d

for f in \
  one \
  two; do
  echo "$f"
done

printf "%s\n" "$@" |
  # each name once
  sort -u | uniq |
  xargs -n1 -- strip 2>err || status=$?

{
  echo grouped
}

(
  cd /tmp
  ls
)

str="a
  multi-line string"
echo ünïcode
