#!/usr/bin/env bash
# Shared environment for running Kestrel's Electron parts on this image.
# The system image ships without the X/GTK/NSS libraries Electron needs, and we
# have no root, so they live unpacked under vendor/x11root (see docs in SPEC).
# Source this file before launching: . scripts/env.sh

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export APP_DIR

ROOT="$APP_DIR/vendor/x11root"
if [ -d "$ROOT" ]; then
  export LD_LIBRARY_PATH="$ROOT/usr/lib/x86_64-linux-gnu:$ROOT/lib/x86_64-linux-gnu:$ROOT/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  export PATH="$ROOT/usr/bin:$PATH"
  export XDG_DATA_DIRS="$ROOT/usr/share:${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"
  export GI_TYPELIB_PATH="$ROOT/usr/lib/x86_64-linux-gnu/girepository-1.0"
  export GDK_PIXBUF_MODULE_FILE="$APP_DIR/vendor/pixbuf-loaders.cache"
fi

# The image has no font packages and no /etc/fonts, which crashes Chromium's
# renderer. Point fontconfig at the fonts unpacked under vendor/fonts.
FONT_DIR="$APP_DIR/vendor/fonts/usr/share/fonts/truetype/dejavu"
if [ -d "$FONT_DIR" ]; then
  FONT_CONF="$APP_DIR/vendor/fonts.conf"
  if [ ! -f "$FONT_CONF" ]; then
    cat > "$FONT_CONF" <<EOF
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>$FONT_DIR</dir>
  <cachedir>/tmp/kestrel-fontconfig</cachedir>
  <alias><family>sans-serif</family><prefer><family>DejaVu Sans</family></prefer></alias>
  <alias><family>monospace</family><prefer><family>DejaVu Sans Mono</family></prefer></alias>
</fontconfig>
EOF
  fi
  export FONTCONFIG_FILE="$FONT_CONF"
fi

# No root, so Chromium's setuid sandbox cannot be used.
export ELECTRON_DISABLE_SANDBOX=1

# A display is required for real windows. Prefer an existing one.
if [ -z "${DISPLAY:-}" ] && [ -x "$(command -v Xvfb 2>/dev/null)" ]; then
  export DISPLAY=:99
fi
