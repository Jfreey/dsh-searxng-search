#!/usr/bin/env bash
# Idempotent SearXNG installer for macOS and Linux, sized for the
# dsh-searxng-search plugin.
#
# Creates: a shallow clone of SearXNG, a virtualenv with its requirements, a
# settings file that serves the JSON API, a launcher wrapper, and a supervisor
# that keeps the server alive — a LaunchAgent on macOS, a systemd user unit on
# Linux. Re-running repairs or upgrades in place and never overwrites an
# existing settings file.
#
#   ./bootstrap-searxng.sh              # install or repair
#   ./bootstrap-searxng.sh --print      # show what would be done
#
# Windows uses bootstrap-searxng.ps1 in this directory.
#
# Environment overrides:
#   SEARXNG_HOME   install directory      (default ~/.local/share/searxng)
#   SEARXNG_PORT   HTTP port              (default 8888)
#   SEARXNG_OS     Darwin | Linux         (default: uname -s; for dry runs)
#   SEARXNG_LABEL  LaunchAgent label      (default com.searxng.server)
#   SEARXNG_UNIT   systemd user unit      (default searxng.service)
#   SEARXNG_PYTHON interpreter            (default python3.11)
#   SEARXNG_REPO   git remote             (default upstream SearXNG)
#   SEARXNG_ENGINES comma-separated roster
#   SEARXNG_BIND   bind address           (default 127.0.0.1; 0.0.0.0 in a container)
#   SEARXNG_PROXY  engine-request proxy    (default empty; e.g. http://127.0.0.1:7890)

set -euo pipefail

SEARXNG_HOME="${SEARXNG_HOME:-$HOME/.local/share/searxng}"
SEARXNG_PORT="${SEARXNG_PORT:-8888}"
SEARXNG_OS="${SEARXNG_OS:-$(uname -s)}"
SEARXNG_LABEL="${SEARXNG_LABEL:-com.searxng.server}"
SEARXNG_UNIT="${SEARXNG_UNIT:-searxng.service}"
SEARXNG_PYTHON="${SEARXNG_PYTHON:-python3.11}"
SEARXNG_REPO="${SEARXNG_REPO:-https://github.com/searxng/searxng.git}"
# Engines that answer from a CN network. The upstream default set is dominated
# by engines that are blocked or CAPTCHA-limited there (google, brave,
# duckduckgo, startpage, qwant, baidu), and every one of them costs a timeout per
# query. wikipedia is excluded on measurement: it answered in no case here and
# pushed a single query from 0.3 s to 15 s before its own timeout. Override with
# a comma-separated list when the network differs.
SEARXNG_ENGINES="${SEARXNG_ENGINES:-bing,sogou,360search}"
# 127.0.0.1 keeps the instance private to the machine. Set 0.0.0.0 only when the
# server runs in a container (or another host) that has to reach it over a
# published port, and firewall that port accordingly.
SEARXNG_BIND="${SEARXNG_BIND:-127.0.0.1}"
# Optional outbound proxy for engine requests, e.g. http://127.0.0.1:7890.
# Written as outgoing.proxies.all:// so every engine uses it.
SEARXNG_PROXY="${SEARXNG_PROXY:-}"

PLIST="$HOME/Library/LaunchAgents/$SEARXNG_LABEL.plist"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/$SEARXNG_UNIT"
SETTINGS="$SEARXNG_HOME/searxng.yml"
LAUNCHER="$SEARXNG_HOME/searxng-server"
VENV="$SEARXNG_HOME/.venv"
DOMAIN="gui/$(id -u)"
HEALTH="http://127.0.0.1:$SEARXNG_PORT/healthz"

DRY_RUN=0
[ "${1:-}" = "--print" ] && DRY_RUN=1

say() { printf '\033[2m·\033[0m %s\n' "$*"; }
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '\033[2m  would run:\033[0m %s\n' "$*"
  else
    "$@"
  fi
}

case "$SEARXNG_OS" in
  Darwin | Linux) ;;
  *) echo "Unsupported platform '$SEARXNG_OS'; this script covers macOS and Linux. Use bootstrap-searxng.ps1 on Windows." >&2; exit 1 ;;
esac
command -v git >/dev/null || { echo "git is required." >&2; exit 1; }

# Only needed when a virtualenv has to be created; an existing one pins its own
# interpreter, which is the common case on a machine with mise-managed pythons.
pick_python() {
  for candidate in "$SEARXNG_PYTHON" python3.11 python3.12 python3.13 python3; do
    [ -n "$candidate" ] || continue
    command -v "$candidate" >/dev/null || continue
    if "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

# 1. Source tree.
if [ -d "$SEARXNG_HOME/.git" ]; then
  say "source present: $SEARXNG_HOME"
elif [ -d "$SEARXNG_HOME" ] && [ -n "$(ls -A "$SEARXNG_HOME" 2>/dev/null)" ]; then
  echo "$SEARXNG_HOME exists and is not a git checkout; move it away first." >&2
  exit 1
else
  say "cloning $SEARXNG_REPO"
  run git clone --depth 1 "$SEARXNG_REPO" "$SEARXNG_HOME"
fi

# 2. Virtualenv and requirements.
if [ -x "$VENV/bin/python" ]; then
  say "virtualenv present"
else
  SEARXNG_PYTHON="$(pick_python)" || {
    echo "SearXNG needs Python 3.11+; none found. Install one (mise, brew) or set SEARXNG_PYTHON." >&2
    exit 1
  }
  say "creating virtualenv with $SEARXNG_PYTHON"
  run "$SEARXNG_PYTHON" -m venv "$VENV"
fi
say "installing requirements (first run takes a few minutes)"
run "$VENV/bin/pip" install --quiet --upgrade pip
run "$VENV/bin/pip" install --quiet -r "$SEARXNG_HOME/requirements.txt"

# 3. Settings: never overwrite an existing file, so local engine edits survive.
if [ -f "$SETTINGS" ]; then
  say "settings present: $SETTINGS"
else
  say "writing $SETTINGS (engines: $SEARXNG_ENGINES)"
  if [ "$DRY_RUN" = 0 ]; then
    secret="$("$VENV/bin/python" -c 'import secrets;print(secrets.token_hex(32))')"
    IFS=',' read -r -a engines <<<"$SEARXNG_ENGINES"
    if [ -n "$SEARXNG_PROXY" ]; then
      proxy_block="  proxies:
    all://:
      - $SEARXNG_PROXY"
    else
      proxy_block=""
    fi
    {
      cat <<YAML
# Generated by dsh-searxng-search/scripts/bootstrap-searxng.sh
use_default_settings:
  engines:
    keep_only:
YAML
      for engine in "${engines[@]}"; do
        engine="$(echo "$engine" | tr -d '[:space:]')"
        [ -n "$engine" ] && printf '      - %s\n' "$engine"
      done
      cat <<YAML

general:
  instance_name: "local-searxng"

server:
  bind_address: "$SEARXNG_BIND"
  port: $SEARXNG_PORT
  secret_key: "$secret"
  limiter: false
  public_instance: false
  image_proxy: false

search:
  safe_search: 0
  autocomplete: ""
  default_lang: "auto"
  formats:
    - html
    - json

# Upstream defaults cut every request at 3s. On a slower route that turns the
# whole engine set into timeouts, so widen both the pool and the deadlines.
outgoing:
  request_timeout: 8.0
  max_request_timeout: 15.0
  pool_connections: 100
  pool_maxsize: 20
  useragent_suffix: ""
$proxy_block
botdetection:
  ip_limit:
    enabled: false
  livecheck:
    enabled: false

ui:
  static_use_hash: true

# keep_only filters the roster; an entry still has to be enabled explicitly,
# because upstream ships most engines disabled.
engines:
YAML
      for engine in "${engines[@]}"; do
        engine="$(echo "$engine" | tr -d '[:space:]')"
        [ -n "$engine" ] && printf '  - name: %s\n    disabled: false\n' "$engine"
      done
    } >"$SETTINGS"
  fi
fi

# 4. Launcher wrapper: names the process, fixes cwd, pins the settings file.
# Always rewritten: it is generated, so a repair has to replace an older one.
say "writing $LAUNCHER"
if [ "$DRY_RUN" = 0 ]; then
  cat >"$LAUNCHER" <<SH
#!/bin/sh
# Generated by dsh-searxng-search/scripts/bootstrap-searxng.sh
cd "$SEARXNG_HOME" || exit 1
export SEARXNG_SETTINGS_PATH="$SETTINGS"
# \`exec -a\` is a bash extension; Debian and Ubuntu run /bin/sh as dash, where it
# fails with "exec: -a: not found". Rename the process only where it exists.
if [ -n "\${BASH_VERSION:-}" ]; then
  exec -a searxng-server "$VENV/bin/python3" -m searx.webapp "\$@"
fi
exec "$VENV/bin/python3" -m searx.webapp "\$@"
SH
  chmod +x "$LAUNCHER"
fi

# 5. Supervisor: a LaunchAgent on macOS, a systemd user unit on Linux. Both
# restart the server after a crash; the plugin only kickstarts them on demand.
SUPERVISOR="launchd"
if [ "$SEARXNG_OS" = "Linux" ]; then
  SUPERVISOR="systemd --user"
  say "writing $UNIT"
  if [ "$DRY_RUN" = 0 ]; then
    mkdir -p "$UNIT_DIR" "$SEARXNG_HOME/logs"
    cat >"$UNIT" <<UNITEOF
[Unit]
Description=SearXNG local metasearch (dsh-searxng-search)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$SEARXNG_HOME
Environment=SEARXNG_SETTINGS_PATH=$SETTINGS
ExecStart=$LAUNCHER
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
UNITEOF
  fi
else
  say "writing $PLIST"
  if [ "$DRY_RUN" = 0 ]; then
    mkdir -p "$(dirname "$PLIST")" "$SEARXNG_HOME/logs"
    cat >"$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>EnvironmentVariables</key>
	<dict>
		<key>SEARXNG_SETTINGS_PATH</key>
		<string>$SETTINGS</string>
	</dict>
	<key>KeepAlive</key>
	<true/>
	<key>Label</key>
	<string>$SEARXNG_LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$LAUNCHER</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>StandardErrorPath</key>
	<string>$SEARXNG_HOME/logs/server.log</string>
	<key>StandardOutPath</key>
	<string>$SEARXNG_HOME/logs/server.log</string>
	<key>WorkingDirectory</key>
	<string>$SEARXNG_HOME</string>
</dict>
</plist>
PLISTEOF
  fi
fi

# 6. (Re)load the supervisor. A missing unit or label is not an error.
if [ "$DRY_RUN" = 0 ]; then
  if [ "$SEARXNG_OS" = "Linux" ]; then
    if ! command -v systemctl >/dev/null; then
      echo "systemctl not found: install 'systemd' or run the launcher by hand ($LAUNCHER)." >&2
      exit 1
    fi
    systemctl --user daemon-reload
    systemctl --user enable --now "$SEARXNG_UNIT" || {
      echo "systemctl --user failed. In a container or over plain SSH without a session bus," >&2
      echo "run: loginctl enable-linger \$USER   then retry." >&2
      exit 1
    }
    systemctl --user restart "$SEARXNG_UNIT"
  else
    launchctl bootout "$DOMAIN/$SEARXNG_LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    launchctl kickstart -k "$DOMAIN/$SEARXNG_LABEL"
  fi
else
  if [ "$SEARXNG_OS" = "Linux" ]; then
    say "would reload $SEARXNG_UNIT via systemctl --user"
  else
    say "would reload $SEARXNG_LABEL"
  fi
fi

# 7. Wait for health, then report.
if [ "$DRY_RUN" = 1 ]; then
  say "would poll $HEALTH"
  exit 0
fi

for _ in $(seq 1 60); do
  if curl -fsS -m 2 "$HEALTH" >/dev/null 2>&1; then
    printf '\n\033[32mSearXNG is up\033[0m → http://127.0.0.1:%s (JSON API, %s, label %s)\n' \
      "$SEARXNG_PORT" "$SUPERVISOR" "$([ "$SEARXNG_OS" = "Linux" ] && echo "$SEARXNG_UNIT" || echo "$SEARXNG_LABEL")"
    exit 0
  fi
  sleep 1
done

echo "SearXNG did not answer $HEALTH within 60s; see $SEARXNG_HOME/logs/server.log" >&2
exit 1
