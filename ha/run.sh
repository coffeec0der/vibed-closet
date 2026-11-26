#!/bin/sh
# Start script for the Home Assistant add-on. Turns the add-on options
# (/data/options.json) into environment variables and keeps a generated login
# secret in /data, then starts Libre Closet. Outside Home Assistant (no
# options file) it simply starts with the defaults.
set -e

DATA_DIR="${HA_DATA_DIR:-/data}"
OPTIONS="${HA_OPTIONS_FILE:-$DATA_DIR/options.json}"
APP_DIR="${APP_DIR:-/app}"

mkdir -p "$DATA_DIR"
export DATA_PATH="${DATA_PATH:-$DATA_DIR}"
export APP_NAME="${APP_NAME:-Libre Closet}"

if [ -f "$OPTIONS" ]; then
  # node is always available here; no jq in the slim image.
  eval "$(node -e '
    const o = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const map = {
      auth_enabled: "AUTH_ENABLED",
      disable_registration: "DISABLE_REGISTRATION",
      currency: "CURRENCY",
      weather_enabled: "WEATHER_ENABLED",
      app_name: "APP_NAME",
    };
    for (const [key, env] of Object.entries(map)) {
      if (o[key] === undefined || o[key] === null || o[key] === "") continue;
      const value = String(o[key]).replace(/\x27/g, "");
      console.log(`export ${env}=\x27${value}\x27`);
    }
  ' "$OPTIONS")"
fi

# A random login (JWT) secret, created once and kept across rebuilds.
SECRET_FILE="$DATA_DIR/.access_token_secret"
if [ -z "$ACCESS_TOKEN_SECRET" ]; then
  if [ ! -s "$SECRET_FILE" ]; then
    node -e 'process.stdout.write(require("crypto").randomBytes(48).toString("base64url"))' > "$SECRET_FILE"
    chmod 600 "$SECRET_FILE"
  fi
  ACCESS_TOKEN_SECRET="$(cat "$SECRET_FILE")"
  export ACCESS_TOKEN_SECRET
fi

echo "Libre Closet: auth=${AUTH_ENABLED:-false} registration_disabled=${DISABLE_REGISTRATION:-false} currency=${CURRENCY:-EUR} weather=${WEATHER_ENABLED:-true} data=$DATA_PATH"
cd "$APP_DIR"
exec node dist/main
