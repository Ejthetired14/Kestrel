#!/usr/bin/env bash
# Builds the Kestrel Android APK with the Android build-tools only (no Gradle,
# no AndroidX, no network dependencies at build time).
#
#   ./build.sh
#
# Needs: JDK 17, and an Android SDK holding platforms/android-33 and
# build-tools/34.0.0. It looks in $ANDROID_SDK_HOME, then ~/toolchain/sdk.
# Output: artifacts/kestrel-mobile-3.2.4.apk (signed with a local sideload key).

set -euo pipefail
cd "$(dirname "$0")"

SDK="${ANDROID_SDK_HOME:-${ANDROID_SDK_ROOT:-$HOME/toolchain/sdk}}"
if [ ! -d "$SDK/platforms/android-33" ]; then SDK="$HOME/toolchain/sdk"; fi
BT="$SDK/build-tools/34.0.0"
PLATFORM="$SDK/platforms/android-33/android.jar"

JAVA_HOME="${JAVA_HOME:-$HOME/toolchain/jdk-17.0.21+9}"
export JAVA_HOME
PATH="$JAVA_HOME/bin:$PATH"
export PATH

for tool in "$BT/aapt2" "$BT/d8" "$BT/zipalign" "$BT/apksigner" "$PLATFORM"; do
  if [ ! -e "$tool" ]; then
    echo "missing build dependency: $tool" >&2
    echo "install it with: sdkmanager \"platforms;android-33\" \"build-tools;34.0.0\"" >&2
    exit 1
  fi
done

APP="$PWD/app"
BUILD="$PWD/build"
OUTDIR="$PWD/../artifacts"
NAME="kestrel-mobile-3.2.4.apk"
KS="$HOME/.kestrel-android/sideload.keystore"

rm -rf "$BUILD"
mkdir -p "$BUILD/gen" "$BUILD/classes" "$BUILD/dex" "$OUTDIR"

echo "1/7 compiling resources"
"$BT/aapt2" compile --dir "$APP/res" -o "$BUILD/res.zip"

echo "2/7 linking manifest, resources and web assets"
"$BT/aapt2" link \
  -o "$BUILD/base.apk" \
  -I "$PLATFORM" \
  --manifest "$APP/AndroidManifest.xml" \
  --java "$BUILD/gen" \
  -A "$APP/assets" \
  --auto-add-overlay \
  "$BUILD/res.zip"

echo "3/7 compiling Java"
find "$APP/src" "$BUILD/gen" -name '*.java' > "$BUILD/sources.txt"
"$JAVA_HOME/bin/javac" -source 8 -target 8 -Xlint:-options \
  -classpath "$PLATFORM" -d "$BUILD/classes" @"$BUILD/sources.txt"

echo "4/7 dexing"
find "$BUILD/classes" -name '*.class' > "$BUILD/classes.txt"
"$BT/d8" --lib "$PLATFORM" --min-api 33 --output "$BUILD/dex" @"$BUILD/classes.txt"

echo "5/7 packing classes.dex"
python3 - "$BUILD/base.apk" "$BUILD/dex/classes.dex" <<'PY'
import sys, zipfile
apk, dex = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(apk, 'a', zipfile.ZIP_DEFLATED) as z:
    z.write(dex, 'classes.dex')
PY

echo "6/7 aligning and signing"
"$BT/zipalign" -f -p 4 "$BUILD/base.apk" "$BUILD/aligned.apk"
if [ ! -f "$KS" ]; then
  mkdir -p "$(dirname "$KS")"
  keytool -genkeypair -keystore "$KS" -storepass android -keypass android \
    -alias kestrel -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Kestrel Sideload, O=Kestrel, C=US" >/dev/null 2>&1
  echo "    created sideload key at $KS (outside the project)"
fi
"$BT/apksigner" sign \
  --ks "$KS" --ks-key-alias kestrel \
  --ks-pass pass:android --key-pass pass:android \
  --min-sdk-version 33 \
  --out "$OUTDIR/$NAME" "$BUILD/aligned.apk"

echo "7/7 verifying signature and manifest"
"$BT/apksigner" verify --min-sdk-version 33 --print-certs "$OUTDIR/$NAME" | head -5
"$BT/aapt" dump badging "$OUTDIR/$NAME" | grep -E "^(package|sdkVersion|targetSdkVersion|launchable-activity|application-label)" || true
echo
echo "APK: $OUTDIR/$NAME  ($(du -h "$OUTDIR/$NAME" | cut -f1))"
