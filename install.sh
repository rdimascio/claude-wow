#!/bin/sh
# WoWGPT installer for macOS and Linux. One line:
#
#   curl -fsSL https://raw.githubusercontent.com/rdimascio/claude-wow/main/install.sh | sh
#
# With options (everything after `-s --` goes to the script):
#
#   curl -fsSL https://raw.githubusercontent.com/rdimascio/claude-wow/main/install.sh | sh -s -- --wow "/Applications/World of Warcraft/_classic_beta_" --project ~/code/my-game --service
#
#   --wow <folder>      the WoW client folder (setup looks in the usual places without it)
#   --project <folder>  the default folder the agents work in
#   --service           install the background service without asking
#   --no-service        don't install or ask (an existing service is otherwise
#                       reinstalled without asking, so it runs the new version)
#   --from-source       no prebuilt binary: clone the repo and run it with Node.js 22.2+ (or WOWGPT_SOURCE=1)
#   --release <tag>     which release's binary (default latest, then the newest release of any kind; or WOWGPT_RELEASE); a named release never falls back
#   --dir <folder>      where the source goes, from source (default ~/.wowgpt/app; or WOWGPT_DIR)
#   --ref <branch|tag>  which version of the source, from source (default main; or WOWGPT_REF)
#
# What it does, in order, and it is safe to run again (an existing install is
# updated, config.json and your chats are kept):
#   1. downloads the wowgpt binary for this machine (macOS arm64 and x64,
#      Linux x64) from the project's GitHub releases into ~/.local/bin, checks
#      it against the release's SHA256SUMS and runs it once. It is the bridge,
#      setup and the service commands in one file with its runtime inside:
#      nothing else to install, no Node.js. Where there is no binary (another
#      platform, no release yet, --from-source) it installs from source instead:
#      checks for Node.js 22.2+, clones the repo into ~/.wowgpt/app with git
#      (or downloads the tarball; nothing to npm-install) and writes a
#      `wowgpt` shim in ~/.local/bin that runs it with node
#   2. runs the game-side setup (addon, config.json, slot pool, background
#      service); config, state and logs live in ~/.wowgpt (WOWGPT_HOME),
#      outside the code. An existing service (under any of the project's
#      names) is reinstalled without asking; a fresh install asks, and Enter
#      means yes. The PATH question also takes Enter as yes.
# A claude-wow install (the name before WoWGPT) is carried over by setup,
# which copies ~/.claude-wow and replaces its service; the CLAUDE_WOW_*
# variables below still count when the WOWGPT_* one is not set.
# Never sudo. Any failure stops with a message saying what to do.

set -eu

REPO_URL=${WOWGPT_REPO:-${CLAUDE_WOW_REPO:-https://github.com/rdimascio/claude-wow}}
REF=${WOWGPT_REF:-${CLAUDE_WOW_REF:-main}}
RELEASE=${WOWGPT_RELEASE:-${CLAUDE_WOW_RELEASE:-latest}}
HOME_DIR=${WOWGPT_HOME:-${CLAUDE_WOW_HOME:-$HOME/.wowgpt}}
DIR=${WOWGPT_DIR:-${CLAUDE_WOW_DIR:-$HOME_DIR/app}}
BIN_DIR=${WOWGPT_BIN:-${CLAUDE_WOW_BIN:-$HOME/.local/bin}}
MIN_NODE=22.2
WOW=${WOWGPT_WOW:-${CLAUDE_WOW_WOW:-}}
PROJECT=${WOWGPT_PROJECT:-${CLAUDE_WOW_PROJECT:-}}
SERVICE=ask
# The background service under this name and the project's old ones
# (bridge/service.js LABEL, OLD_LABEL, UNIT, OLD_UNIT).
LAUNCHD_LABELS="io.wowgpt.bridge io.claudewow.bridge io.wowai.bridge"
SYSTEMD_UNITS="wowgpt-bridge claude-wow-bridge wow-ai-bridge"
SOURCE=${WOWGPT_SOURCE:-${CLAUDE_WOW_SOURCE:-}}
CMD=                 # the wowgpt command once it is in place: the binary, or the shim that runs the source with node
RUN=wowgpt           # how the final lines name the command: wowgpt, or its full path while it is not on the PATH

say()  { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
fail() {
  printf '\ninstall failed: %s\n' "$1" >&2
  [ $# -gt 1 ] && printf '  -> %s\n' "$2" >&2
  exit 1
}

# Is a node version string (v22.2.0, 22.10.1) at least MIN_NODE? Pure; used by the tests.
node_ok() {
  v=${1#v}
  maj=${v%%.*}
  case "$v" in *.*) rest=${v#*.}; min=${rest%%.*} ;; *) min=0 ;; esac
  case "$maj$min" in *[!0-9]*|'') return 1 ;; esac
  want_maj=${MIN_NODE%%.*}; want_min=${MIN_NODE#*.}
  [ "$maj" -gt "$want_maj" ] || { [ "$maj" -eq "$want_maj" ] && [ "$min" -ge "$want_min" ]; }
}

os_name() { case "$(uname -s)" in Darwin) echo macOS ;; Linux) echo Linux ;; *) uname -s ;; esac; }

# The release asset built for this machine (build.js names them), or nothing.
binary_asset() {
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) echo wowgpt-darwin-arm64 ;;
    Darwin-x86_64) echo wowgpt-darwin-x64 ;;
    Linux-x86_64) echo wowgpt-linux-x64 ;;
    *) echo "" ;;
  esac
}

release_base() {
  if [ "$RELEASE" = latest ]; then echo "$REPO_URL/releases/latest/download"; else echo "$REPO_URL/releases/download/$RELEASE"; fi
}

first_tag_name() {
  sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

newest_release_tag() {
  case "$REPO_URL" in
    https://github.com/*) api_url="https://api.github.com/repos/${REPO_URL#https://github.com/}/releases?per_page=1" ;;
    *) return 1 ;;
  esac
  newest=$(curl -fsSL -H 'Accept: application/vnd.github+json' "$api_url" 2>/dev/null | first_tag_name)
  [ -n "$newest" ] || return 1
  echo "$newest"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else echo ""; fi
}

node_hint() {
  if [ "$(os_name)" = macOS ]; then
    echo "Install it with Homebrew (brew install node) or the installer at https://nodejs.org, open a new terminal, and run this again."
  else
    echo "Install it from your package manager, https://nodejs.org, or with fnm (https://github.com/Schniz/fnm), open a new terminal, and run this again."
  fi
}

# Ask on the terminal even when the script itself came in on stdin (curl | sh).
ask() {
  answer=
  if ( : < /dev/tty ) 2>/dev/null; then
    printf '%s' "$1" > /dev/tty
    read -r answer < /dev/tty || answer=
  fi
  case "$answer" in y|Y|yes|YES|Yes) return 0 ;; *) return 1 ;; esac
}

# The same for a question whose default is yes: Enter alone is yes. With no
# terminal to ask on, nothing is answered and the answer is no.
ask_yes() {
  ( : < /dev/tty ) 2>/dev/null || return 1
  printf '%s' "$1" > /dev/tty
  answer=
  read -r answer < /dev/tty || answer=
  case "$answer" in ''|y|Y|yes|YES|Yes) return 0 ;; *) return 1 ;; esac
}

# A service definition for this bridge under any of its names.
service_defined() {
  for label in $LAUNCHD_LABELS; do
    [ -f "$HOME/Library/LaunchAgents/$label.plist" ] && return 0
  done
  for unit in $SYSTEMD_UNITS; do
    [ -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$unit.service" ] && return 0
  done
  return 1
}

# What setup does about the service: --no-service and --service as given; an
# existing service is reinstalled without asking; a fresh install asks.
service_flag() {
  case "$SERVICE" in
    no) echo --no-service ;;
    yes) echo --service ;;
    *)
      if service_defined; then
        echo --service
      elif ask_yes "Run the bridge in the background and start it at login? [Y/n] "; then
        echo --service
      else
        echo --no-service
      fi
      ;;
  esac
}

rc_file() {
  case "${SHELL:-}" in
    */zsh) echo "$HOME/.zshrc" ;;
    */fish) echo "$HOME/.config/fish/config.fish" ;;
    *) if [ "$(os_name)" = macOS ]; then echo "$HOME/.bash_profile"; else echo "$HOME/.bashrc"; fi ;;
  esac
}

# The binary route. Returns 1, with a line saying why, whenever the source
# route should be taken instead; fails outright only for a download that
# arrived but is wrong (a checksum mismatch, a binary that does not run).
get_binary() {
  asset=$(binary_asset)
  [ -n "$asset" ] || { say "no prebuilt binary for $(uname -s) $(uname -m)"; return 1; }
  command -v curl >/dev/null 2>&1 || { say "curl is not available"; return 1; }
  base=$(release_base)
  tmp=$(mktemp -d 2>/dev/null || mktemp -d -t wowgpt)
  say "downloading $base/$asset"
  if ! curl -fsSL "$base/$asset" -o "$tmp/$asset" 2>/dev/null; then
    newest=
    if [ "$RELEASE" = latest ]; then newest=$(newest_release_tag || true); fi
    if [ -n "$newest" ]; then
      base="$REPO_URL/releases/download/$newest"
      say "the latest stable release has no $asset; trying the newest release, $newest: $base/$asset"
    fi
    if [ -z "$newest" ] || ! curl -fsSL "$base/$asset" -o "$tmp/$asset" 2>/dev/null; then
      rm -rf "$tmp"
      say "no binary at $base/$asset (no release for it yet, or no network)"
      return 1
    fi
  fi
  if curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" 2>/dev/null; then
    want=$(grep "[[:space:]]$asset\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)
    have=$(sha256_of "$tmp/$asset")
    if [ -z "$have" ]; then
      say "warning: neither sha256sum nor shasum is here, so the download was not verified"
    elif [ -z "$want" ] || [ "$want" != "$have" ]; then
      rm -rf "$tmp"
      fail "the downloaded $asset does not match the release's SHA256SUMS" "Run this again; if it keeps failing, install from source with --from-source."
    else
      say "checksum OK"
    fi
  else
    say "warning: the release has no SHA256SUMS, so the download was not verified"
  fi
  chmod +x "$tmp/$asset"
  if ! "$tmp/$asset" service help >/dev/null 2>&1; then
    rm -rf "$tmp"
    fail "the downloaded binary does not run on this machine" "Run this again with --from-source to use Node.js instead."
  fi
  mkdir -p "$BIN_DIR" || fail "cannot create $BIN_DIR" "Pick another folder with WOWGPT_BIN=<folder>."
  # mv, not cp: a bridge that is running the old binary keeps its file until it restarts.
  mv -f "$tmp/$asset" "$BIN_DIR/wowgpt"
  rm -rf "$tmp"
  CMD=$BIN_DIR/wowgpt
  say "wowgpt: $CMD ($("$CMD" --version 2>/dev/null || echo binary))"
  return 0
}

# The source route: Node.js, the code, and a shim that runs it.
get_source() {
  say "installing from source"
  command -v node >/dev/null 2>&1 || fail "Node.js is not installed (or not on the PATH), and there is no prebuilt binary to use instead" "$(node_hint)"
  NODE_BIN=$(command -v node)
  NODE_VER=$(node -v 2>/dev/null || echo unknown)
  node_ok "$NODE_VER" || fail "Node.js $NODE_VER is too old; $MIN_NODE or newer is required" "$(node_hint)"
  say "node $NODE_VER ($NODE_BIN)"
  get_code
  [ -f "$DIR/setup.js" ] || fail "$DIR does not contain setup.js after the download" "Remove $DIR and run this again."
  mkdir -p "$BIN_DIR" || fail "cannot create $BIN_DIR" "Pick another folder with WOWGPT_BIN=<folder>."
  cat > "$BIN_DIR/wowgpt" <<EOF
#!/bin/sh
# WoWGPT: written by install.sh. Runs the bridge from $DIR.
NODE=\$(command -v node 2>/dev/null || echo "$NODE_BIN")
exec "\$NODE" "$DIR/bridge/supervisor.js" "\$@"
EOF
  chmod +x "$BIN_DIR/wowgpt"
  CMD=$BIN_DIR/wowgpt
  say "wowgpt command: $CMD (runs $DIR with node)"
}

get_code() {
  if [ -d "$DIR/.git" ]; then
    say "updating the existing install in $DIR"
    if git -C "$DIR" pull --ff-only --quiet 2>/dev/null; then
      say "up to date with $REF"
    else
      say "warning: could not fast-forward $DIR (local changes or no network); keeping what is there"
    fi
    return
  fi
  if [ -e "$DIR" ] && [ ! -f "$DIR/setup.js" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
    fail "$DIR exists and is not a wowgpt install" "Pick another folder with --dir <folder> (or WOWGPT_DIR), or move that one aside."
  fi
  if command -v git >/dev/null 2>&1 && [ ! -f "$DIR/setup.js" ]; then
    say "cloning $REPO_URL ($REF) into $DIR"
    git clone --quiet --depth 1 --branch "$REF" "$REPO_URL" "$DIR" || fail "git clone failed" "Check the network and that $REPO_URL is reachable, then run this again."
    return
  fi
  # No git (or a previous tarball install to refresh): download the archive.
  command -v curl >/dev/null 2>&1 || fail "neither git nor curl is available" "Install git (macOS: xcode-select --install) and run this again."
  command -v tar >/dev/null 2>&1 || fail "tar is not available" "Install tar from your package manager and run this again."
  tmp=$(mktemp -d 2>/dev/null || mktemp -d -t wowgpt)
  say "downloading $REPO_URL/archive/refs/heads/$REF.tar.gz"
  if ! curl -fsSL "$REPO_URL/archive/refs/heads/$REF.tar.gz" | tar -xz -C "$tmp" 2>/dev/null; then
    curl -fsSL "$REPO_URL/archive/refs/tags/$REF.tar.gz" | tar -xz -C "$tmp" || fail "download failed" "Check the network, or install git and run this again."
  fi
  src=$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -n 1)
  [ -f "$src/setup.js" ] || fail "the archive did not contain wowgpt" "Try again with git installed."
  mkdir -p "$DIR"
  # cp over the old files; config.json, state.json and transcripts.json are not in the archive, so they survive.
  cp -R "$src/." "$DIR/"
  rm -rf "$tmp"
  say "installed into $DIR (no git: run this script again to update)"
}

on_path() {
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      rc=$(rc_file)
      line="export PATH=\"$BIN_DIR:\$PATH\""
      [ "${rc##*/}" = config.fish ] && line="fish_add_path $BIN_DIR"
      if [ -f "$rc" ] && grep -Fq "$BIN_DIR" "$rc" 2>/dev/null; then
        say "$BIN_DIR is already in $rc; open a new terminal for the wowgpt command"
      elif ask_yes "$BIN_DIR is not on your PATH. Add it to $rc? [Y/n] "; then
        printf '\n# wowgpt\n%s\n' "$line" >> "$rc"
        say "added to $rc; open a new terminal for the wowgpt command"
      else
        RUN=$BIN_DIR/wowgpt
        say "to use the wowgpt command from any folder, add this to $rc:  $line"
      fi
      ;;
  esac
}

main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --wow) WOW=${2:-}; shift ;;
      --project) PROJECT=${2:-}; shift ;;
      --dir) DIR=${2:-}; shift ;;
      --ref) REF=${2:-}; shift ;;
      --release) RELEASE=${2:-}; shift ;;
      --from-source) SOURCE=1 ;;
      --service) SERVICE=yes ;;
      --no-service) SERVICE=no ;;
      --node-ok) node_ok "${2:-}" && { echo ok; exit 0; } || { echo "too old: need $MIN_NODE"; exit 1; } ;;
      --binary-asset) binary_asset; exit 0 ;;
      -h|--help) sed -n '/^set -eu$/q;2,$p' "$0" 2>/dev/null || say "see the header of install.sh"; exit 0 ;;
      *) fail "unknown option $1" "Options: --wow <folder> --project <folder> --service --no-service --from-source --release <tag> --dir <folder> --ref <ref>" ;;
    esac
    shift
  done
  [ "$(id -u 2>/dev/null || echo 1000)" -ne 0 ] || fail "do not run this as root" "Run it as the user who plays the game; nothing here needs sudo."

  step "1/2 The bridge"
  if [ -n "$SOURCE" ]; then
    get_source
  elif [ "$RELEASE" != latest ] && [ -z "$(binary_asset)" ]; then
    fail "no wowgpt binary exists for $(uname -s) $(uname -m), in release $RELEASE or any other; a pinned release never falls back to the source" \
      "Run this again with --from-source to run $REF with Node.js."
  elif ! get_binary; then
    [ "$RELEASE" = latest ] || fail "release $RELEASE has no wowgpt binary for this machine, or it could not be downloaded; a pinned release never falls back to another release or to the source" \
      "Check that $REPO_URL/releases/tag/$RELEASE exists and has a binary for this machine, and check the network. Or drop --release (WOWGPT_RELEASE) for the newest release, or add --from-source to run $REF with Node.js."
    get_source
  fi
  on_path
  SERVICE_FLAG=$(service_flag)
  [ "$SERVICE" = ask ] && [ "$SERVICE_FLAG" = --service ] && service_defined && say "a background service is installed; setup reinstalls it so it runs this version"

  step "2/2 Game-side setup (addon, config, slot pool, background service)"
  set -- "$SERVICE_FLAG"
  [ -n "$WOW" ] && set -- "$@" --wow "$WOW"
  [ -n "$PROJECT" ] && set -- "$@" --project "$PROJECT"
  if [ ! -f "$HOME_DIR/config.json" ]; then
    if ask "Share your game state with the agent? This sends your character, zone, quests, money, bags and professions to the agent provider (for example Anthropic or OpenAI) with each message. [y/N] "; then
      set -- "$@" --share-game-state yes
    else
      set -- "$@" --share-game-state no
    fi
  fi
  if ! "$CMD" setup "$@"; then
    fail "the game-side setup did not finish (see above)" \
      "The wowgpt command is installed. Fix what setup reported (usually: pass the client folder), then run:  wowgpt setup --wow \"<World of Warcraft/_classic_beta_>\""
  fi

  printf '\nInstalled. The Next steps above are what is left.\n'
  if [ "$RUN" != wowgpt ]; then
    say "The wowgpt command is $RUN (its folder is not on your PATH)."
  fi
  if [ "$CMD" = "$BIN_DIR/wowgpt" ] && [ -z "$SOURCE" ] && [ ! -f "$DIR/setup.js" ]; then
    say "Update later by running this installer again (it replaces the binary and restarts the service)."
  else
    say "Update later by running this installer again. Code: $DIR"
  fi
}

main "$@"
