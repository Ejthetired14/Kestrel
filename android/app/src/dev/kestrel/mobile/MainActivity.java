package dev.kestrel.mobile;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Kestrel on Android: one WebView showing the bundled UI, plus a small native
 * bridge for the workspace files, the encrypted key store and streaming HTTP.
 */
public class MainActivity extends Activity {

    private static final int PICK_FILES = 41;
    private static final int DICTATE = 42;

    private WebView web;
    private Bridge bridge;
    private String pendingCallback;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        getWindow().setStatusBarColor(Color.parseColor("#0D1117"));
        getWindow().setNavigationBarColor(Color.parseColor("#0D1117"));

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0D1117"));
        web.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setTextZoom(100);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);

        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient());
        bridge = new Bridge(this, web);
        web.addJavascriptInterface(bridge, "KestrelNative");

        setContentView(web);
        web.loadUrl("file:///android_asset/www/index.html");
    }

    /** Called from the bridge: open the system document/photo picker. */
    void startFilePicker(String kind, String callbackId) {
        pendingCallback = callbackId;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("image/*".equals(kind) ? "image/*" : "*/*");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        try {
            startActivityForResult(intent, PICK_FILES);
        } catch (Exception err) {
            if (bridge != null) bridge.handlePicked(callbackId, new java.util.ArrayList<>());
        }
    }

    /** Called from the bridge: the phone's own speech recogniser, no permission needed. */
    void startDictation() {
        Intent intent = new Intent(android.speech.RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(
                android.speech.RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                android.speech.RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(android.speech.RecognizerIntent.EXTRA_PROMPT, "Speak to Kestrel");
        try {
            startActivityForResult(intent, DICTATE);
        } catch (Exception err) {
            if (web != null) {
                web.post(() -> web.evaluateJavascript("window.__kestrelDictation && window.__kestrelDictation('')", null));
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == DICTATE) {
            String heard = "";
            if (resultCode == RESULT_OK && data != null) {
                java.util.ArrayList<String> matches =
                        data.getStringArrayListExtra(android.speech.RecognizerIntent.EXTRA_RESULTS);
                if (matches != null && !matches.isEmpty()) heard = matches.get(0);
            }
            if (web != null) {
                final String words = heard;
                web.post(() -> web.evaluateJavascript(
                        "window.__kestrelDictation && window.__kestrelDictation(" + org.json.JSONObject.quote(words) + ")",
                        null));
            }
            return;
        }
        if (requestCode != PICK_FILES || bridge == null) return;
        java.util.List<Uri> uris = new java.util.ArrayList<>();
        if (resultCode == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null) {
                for (int i = 0; i < clip.getItemCount(); i++) uris.add(clip.getItemAt(i).getUri());
            } else if (data.getData() != null) {
                uris.add(data.getData());
            }
        }
        bridge.handlePicked(pendingCallback, uris);
        pendingCallback = null;
    }

    /** The hardware back button closes an open sheet before it leaves the app. */
    @Override
    public void onBackPressed() {
        if (web == null) {
            super.onBackPressed();
            return;
        }
        web.evaluateJavascript(
                "(function(){ try { return window.__kestrelBack ? String(window.__kestrelBack()) : 'false'; } catch (e) { return 'false'; } })()",
                value -> {
                    if (!"true".equals(value)) {
                        finish();
                    }
                });
    }

    @Override
    protected void onDestroy() {
        if (bridge != null) bridge.close();
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
