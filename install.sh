#!/usr/bin/env bash
# Install Studio on this machine (Linux or Apple-silicon macOS), from a clone of the repository:
#
#   ./install.sh            set up everything, asking before each download
#   ./install.sh --yes      the same, without asking
#   ./install.sh --service  also run Studio as a boot service (Linux, systemd)
#   ./install.sh --uninstall  remove the `studio` command (your data in ~/.config/studio stays)
#
# What it does, in order, skipping anything already done:
#   1. Node >= 22.18: uses yours if it's new enough, otherwise downloads the official build
#      into ~/.local/share/studio/node (just for Studio; your system Node isn't touched).
#   2. T3 Code: installs the version in T3_VERSION with T3's own installer (into ~/.t3).
#   3. Studio's packages: npm ci.
#   4. The `studio` command: a link in ~/.local/bin.
#   5. Checks for agent CLIs (Claude Code, Codex, OpenCode). It doesn't install or sign in to
#      them: that needs your accounts.
set -euo pipefail

STUDIO_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
BIN_DIR="$HOME/.local/bin"
NODE_DIR="$HOME/.local/share/studio/node"
NODE_MIN="22.18.0"
T3_PIN="$(tr -d '[:space:]' <"$STUDIO_DIR/T3_VERSION")"

YES=0 SERVICE=0
for a in "$@"; do
  case "$a" in
    -y | --yes) YES=1 ;;
    --service) SERVICE=1 ;;
    --uninstall)
      rm -f "$BIN_DIR/studio"
      echo "Removed the 'studio' command. Still here, remove by hand if you want:"
      echo "  $HOME/.config/studio  (hub database, worker sign-ins, vault)"
      echo "  $NODE_DIR  (Studio's Node, if install.sh downloaded one)"
      echo "  T3 Code: ~/.t3 and ~/.local/bin/t3. Boot services: run 'studio service off' first."
      exit 0
      ;;
    -h | --help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install.sh: unknown option $a" >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then B=$'\e[1m' D=$'\e[2m' G=$'\e[32m' Y=$'\e[33m' R=$'\e[31m' N=$'\e[0m'; else B= D= G= Y= R= N=; fi
step() { printf '\n%s==>%s %s%s%s\n' "$G" "$N" "$B" "$*" "$N"; }
note() { printf '    %s\n' "$*"; }
die() { printf '%sinstall.sh:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }
ask() { # question -> 0 for yes
  [ "$YES" = 1 ] && return 0
  [ -t 0 ] || die "$1 (re-run with --yes to allow this without a prompt)"
  local r; read -r -p "    $1 [Y/n] " r; [[ -z "$r" || "$r" =~ ^[Yy] ]]
}
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; }
fetch() { curl -fsSL --retry 3 "$1"; }

command -v curl >/dev/null || die "curl is required"
command -v git >/dev/null || die "git is required (agents work in git worktrees)"
case "$(uname -s)" in Linux) OS=linux ;; Darwin) OS=darwin ;; *) die "on Windows, use install.ps1" ;; esac
case "$(uname -m)" in x86_64 | amd64) ARCH=x64 ;; aarch64 | arm64) ARCH=arm64 ;; *) die "unsupported CPU: $(uname -m)" ;; esac

# ---------------------------------------------------------------- 1. Node
step "Node >= $NODE_MIN"
[ -x "$NODE_DIR/bin/node" ] && PATH="$NODE_DIR/bin:$PATH"
if command -v node >/dev/null && version_ge "$(node -p 'process.versions.node')" "$NODE_MIN"; then
  note "using $(command -v node) ($(node -v))"
else
  if command -v node >/dev/null; then note "found Node $(node -v), which is too old for Studio"; fi
  ask "Download Node 22 (official build) into $NODE_DIR?" || die "install Node >= $NODE_MIN yourself, then re-run"
  base="https://nodejs.org/dist/latest-v22.x"
  sums="$(fetch "$base/SHASUMS256.txt")"
  file="$(printf '%s\n' "$sums" | grep -oE "node-v22\.[0-9.]+-$OS-$ARCH\.tar\.gz" | head -n1)"
  [ -n "$file" ] || die "no Node 22 build for $OS-$ARCH"
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  note "downloading $file"
  fetch "$base/$file" >"$tmp/$file"
  want="$(printf '%s\n' "$sums" | awk -v f="$file" '$2 == f { print $1 }')"
  if command -v sha256sum >/dev/null; then got="$(sha256sum "$tmp/$file" | cut -d' ' -f1)"; else got="$(shasum -a 256 "$tmp/$file" | cut -d' ' -f1)"; fi
  [ "$want" = "$got" ] || die "checksum mismatch for $file"
  rm -rf "$NODE_DIR"; mkdir -p "$NODE_DIR"
  tar -xzf "$tmp/$file" -C "$NODE_DIR" --strip-components=1
  PATH="$NODE_DIR/bin:$PATH"
  note "installed $(node -v) (only Studio uses it)"
fi
export PATH

# ---------------------------------------------------------------- 2. T3 Code
step "T3 Code $T3_PIN"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) PATH="$PATH:$BIN_DIR" ;; esac
have=""
command -v t3 >/dev/null && have="$(t3 --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)"
if [ "$have" = "$T3_PIN" ]; then
  note "already installed ($(command -v t3))"
else
  if [ -n "$have" ]; then
    note "found T3 $have; Studio is tested with $T3_PIN"
    msg="Install T3 $T3_PIN with T3's installer (https://t3.codes/install.sh)? Your projects and settings in ~/.t3 stay."
  else
    msg="Install T3 $T3_PIN with T3's installer (https://t3.codes/install.sh)?"
  fi
  if ask "$msg"; then
    fetch https://t3.codes/install.sh | T3CODE_VERSION="$T3_PIN" sh
  elif [ -z "$have" ]; then
    die "Studio needs T3 Code. Install it from https://t3.codes, then re-run"
  else
    note "keeping T3 $have"
  fi
fi

# ---------------------------------------------------------------- 3. packages
step "Studio packages"
(cd "$STUDIO_DIR" && npm_config_update_notifier=false npm ci --no-audit --no-fund --loglevel=error)

# ---------------------------------------------------------------- 4. command
step "The 'studio' command"
mkdir -p "$BIN_DIR"
chmod +x "$STUDIO_DIR/bin/studio"
ln -sfn "$STUDIO_DIR/bin/studio" "$BIN_DIR/studio"
note "$BIN_DIR/studio -> $STUDIO_DIR/bin/studio"
on_path=1
case ":$(bash -lc 'echo $PATH' 2>/dev/null):" in *":$BIN_DIR:"*) ;; *) on_path=0 ;; esac

# ---------------------------------------------------------------- 5. agents
step "Agent CLIs (T3 runs these; you need at least one, signed in)"
any=0
for c in "claude|Claude Code|https://claude.com/product/claude-code|claude auth login" \
  "codex|Codex|https://developers.openai.com/codex/cli|codex login" \
  "opencode|OpenCode|https://opencode.ai|free models need no login"; do
  IFS='|' read -r bin name url login <<<"$c"
  if command -v "$bin" >/dev/null; then note "${G}✓${N} $name"; any=1
  else note "${D}- $name not found: $url ($login)${N}"; fi
done
[ "$any" = 1 ] || note "${Y}Install at least one before starting a job.${N}"

if [ "$SERVICE" = 1 ]; then
  step "Boot services"
  "$STUDIO_DIR/bin/studio" service on
fi

printf '\n%sStudio is installed.%s\n' "$B" "$N"
if [ "$on_path" = 0 ]; then
  printf '%s%s is not on your PATH.%s Add this to your shell profile, then open a new terminal:\n' "$Y" "$BIN_DIR" "$N"
  printf '    export PATH="$HOME/.local/bin:$PATH"\n'
fi
cat <<EOF

    studio                 start Studio (and T3 under it) and open it in the browser
    studio service on      keep it running at boot instead (Linux)
    studio lan on          use it from other computers on your network
    studio doctor          check the setup
EOF
