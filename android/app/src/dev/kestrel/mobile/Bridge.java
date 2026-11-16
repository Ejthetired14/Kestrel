package dev.kestrel.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.Reader;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The native side of Kestrel's mobile build.
 *
 * Three jobs, nothing else:
 *   1. a private file workspace (files dir / workspace) that the UI's tools read and write,
 *   2. an API-key store encrypted with an Android keystore key,
 *   3. streaming HTTP, because WebView pages on file:// cannot call provider APIs directly.
 */
public class Bridge {

    private static final String KEY_ALIAS = "kestrel-master";
    private static final String PREFS = "kestrel-keys";
    private static final int MAX_READ = 4 * 1024 * 1024;

    private static final String STATE = "kestrel-state";
    private static final long MAX_ARCHIVE = 40L * 1024 * 1024;
    private static final long MAX_FILE_IN_ARCHIVE = 5L * 1024 * 1024;
    private static final long MAX_EXTRACTED = 60L * 1024 * 1024;

    private ServerSocket fileServer;
    private int fileServerPort;
    private android.speech.tts.TextToSpeech tts;

    private final Context context;
    private final WebView web;
    private final File projectsRoot;
    private final Map<String, HttpURLConnection> live = new ConcurrentHashMap<>();

    /** Every read and write resolves against this folder; switching projects swaps it. */
    private File root;
    private String currentId;

    Bridge(Context context, WebView web) {
        this.context = context;
        this.web = web;
        this.projectsRoot = new File(context.getFilesDir(), "projects");
        if (!projectsRoot.exists()) projectsRoot.mkdirs();
        migrateProjects();
    }

    /**
     * One folder per project under files/projects. A workspace from an older build
     * (files/workspace) becomes the first project, so nothing the user already
     * wrote disappears.
     */
    private void migrateProjects() {
        File legacy = new File(context.getFilesDir(), "workspace");
        File[] existing = projectsRoot.listFiles();
        boolean empty = existing == null || existing.length == 0;
        if (legacy.isDirectory() && empty) legacy.renameTo(new File(projectsRoot, "my-project"));
        existing = projectsRoot.listFiles();
        if (existing == null || existing.length == 0) new File(projectsRoot, "my-project").mkdirs();

        String saved = state().getString("project", null);
        File chosen = saved == null ? null : new File(projectsRoot, saved);
        if (chosen == null || !chosen.isDirectory()) {
            File[] all = projectsRoot.listFiles();
            chosen = all != null && all.length > 0 ? all[0] : new File(projectsRoot, "my-project");
            if (!chosen.exists()) chosen.mkdirs();
        }
        currentId = chosen.getName();
        root = chosen;
        state().edit().putString("project", currentId).apply();
    }

    private SharedPreferences state() {
        return context.getSharedPreferences(STATE, Context.MODE_PRIVATE);
    }

    /* ------------------------------------------------------------ filesystem */

    private File resolve(String relative) throws Exception {
        String clean = relative == null ? "" : relative.replace('\\', '/');
        while (clean.startsWith("/")) clean = clean.substring(1);
        File candidate = new File(root, clean);
        String rootPath = root.getCanonicalPath();
        String path = candidate.getCanonicalPath();
        if (!path.equals(rootPath) && !path.startsWith(rootPath + File.separator)) {
            throw new Exception("path escapes the workspace");
        }
        return candidate;
    }

    @JavascriptInterface
    public String readFile(String path) {
        try {
            File file = resolve(path);
            if (!file.isFile()) return error("no such file: " + path);
            if (file.length() > MAX_READ) return error("file is larger than 4 MB");
            byte[] buffer = new byte[(int) file.length()];
            try (FileInputStream in = new FileInputStream(file)) {
                int read = 0;
                while (read < buffer.length) {
                    int n = in.read(buffer, read, buffer.length - read);
                    if (n < 0) break;
                    read += n;
                }
            }
            JSONObject out = new JSONObject();
            out.put("ok", true);
            out.put("content", new String(buffer, StandardCharsets.UTF_8));
            out.put("bytes", buffer.length);
            return out.toString();
        } catch (Exception err) {
            return error(err.getMessage());
        }
    }

    @JavascriptInterface
    public String writeFile(String path, String content) {
        try {
            File file = resolve(path);
            File parent = file.getParentFile();
            if (parent != null && !parent.exists() && !parent.mkdirs()) {
                return error("could not create " + parent.getName());
            }
            byte[] bytes = (content == null ? "" : content).getBytes(StandardCharsets.UTF_8);
            try (FileOutputStream out = new FileOutputStream(file)) {
                out.write(bytes);
            }
            JSONObject result = new JSONObject();
            result.put("ok", true);
            result.put("bytes", bytes.length);
            return result.toString();
        } catch (Exception err) {
            return error(err.getMessage());
        }
    }

    @JavascriptInterface
    public String deleteFile(String path) {
        try {
            File file = resolve(path);
            if (!file.exists()) return error("no such file: " + path);
            deleteTree(file);
            JSONObject result = new JSONObject();
            result.put("ok", true);
            return result.toString();
        } catch (Exception err) {
            return error(err.getMessage());
        }
    }

    private void deleteTree(File file) {
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) deleteTree(child);
        }
        file.delete();
    }

    @JavascriptInterface
    public String exists(String path) {
        try {
            JSONObject result = new JSONObject();
            result.put("ok", true);
            result.put("exists", resolve(path).exists());
            return result.toString();
        } catch (Exception err) {
            return error(err.getMessage());
        }
    }

    @JavascriptInterface
    public String statFile(String path) {
        try {
            File file = resolve(path);
            JSONObject result = new JSONObject();
            result.put("ok", true);
            result.put("size", file.isFile() ? file.length() : 0);
            result.put("dir", file.isDirectory());
            return result.toString();
        } catch (Exception err) {
            return error(err.getMessage());
        }
    }

    @JavascriptInterface
    public String listDir(String path) {
        try {
            File dir = resolve(path);
            JSONArray entries = new JSONArray();
            File[] children = dir.listFiles();
            if (children != null) {
                java.util.Arrays.sort(children, (a, b) -> {
                    if (a.isDirectory() != b.isDirectory()) return a.isDirectory() ? -1 : 1;
                    return a.getName().compareToIgnoreCase(b.getName());
                });
                String prefix = path == null || path.isEmpty() ? "" : path.replace('\\', '/') + "/";
                for (File child : children) {
                    JSONObject entry = new JSONObject();
                    entry.put("name", child.getName());
                    entry.put("path", prefix + child.getName());
                    entry.put("dir", child.isDirectory());
                    entry.put("size", child.isFile() ? child.length() : 0);
                    entries.put(entry);
                }
            }
            JSONObject result = new JSONObject();
            result.put("ok", true);
            result.put("entries", entries);
            return result.toString();
        } catch (Exception err) {
            return error(err.getMessage());
        }
    }

    /* -------------------------------------------------------------- projects */

    private File projectDir(String id) throws Exception {
        String clean = id == null ? "" : id.trim();
        if (!clean.matches("[a-z0-9][a-z0-9._-]{0,63}")) throw new Exception("invalid project name: " + id);
        return new File(projectsRoot, clean);
    }

    private void countTree(File file, long[] counts) {
        File[] kids = file.listFiles();
        if (kids == null) {
            counts[0] += 1;
            counts[1] += file.length();
            return;
        }
        for (File kid : kids) {
            if (kid.isDirectory()) countTree(kid, counts);
            else {
                counts[0] += 1;
                counts[1] += kid.length();
            }
        }
    }

    @JavascriptInterface
    public String listProjects() {
        try {
            JSONArray projects = new JSONArray();
            File[] dirs = projectsRoot.listFiles();
            if (dirs != null) {
                java.util.Arrays.sort(dirs, (a, b) -> a.getName().compareToIgnoreCase(b.getName()));
                for (File dir : dirs) {
                    if (!dir.isDirectory()) continue;
                    long[] counts = new long[2];
                    countTree(dir, counts);
                    JSONObject item = new JSONObject();
                    item.put("id", dir.getName());
                    item.put("files", counts[0]);
                    item.put("bytes", counts[1]);
                    item.put("current", dir.getName().equals(currentId));
                    projects.put(item);
                }
            }
            JSONObject result = new JSONObject();
            result.put("ok", true);
            result.put("projects", projects);
            result.put("current", currentId);
            return result.toString();
        } catch (Exception err) {
            return error(err.getMessage());
        }
    }

    @JavascriptInterface
    public String currentProject() {
        try {
            JSONObject result = new JSONObject();
            result.put("ok", true);
            result.put("id", currentId);
            return result.toString();
        } catch (Exception err) {
            return error(err.getMessage());
        }
    }

    @JavascriptInterface
    public String useProject(String id) {
        try {
            File dir = projectDir(id);
            if (!dir.isDirectory()) return error("no such project: " + id);
            currentId = dir.getName();
            root = dir;
            state().edit().putString("project", currentId).apply();
            JSONObject result = new JSONObject();
            result.put("ok", true);
            result.put("id", currentId);
            return result.toString();
        } catch (Exception err) {
            return error(err.getMessage());
        }
    }

    @JavascriptInterface
    public String createProject(String id) {
        try {
            File dir = projectDir(id);
            if (dir.exists()) return error("a project called " + dir.getName() + " already exists");
            if (!dir.mkdirs()) return error("could not create the project folder");
            currentId = dir.getName();
            root = dir;
            state().edit().putString("project", currentId).apply();
            JSONObject result = new JSONObject();
            result.put("ok", true);
            result.put("id", currentId);
            return result.toString();
        } catch (Exception err) {
            return error(err.getMessage());
        }
    }

    @JavascriptInterface
    public String deleteProject(String id) {
        try {
            File dir = projectDir(id);
            if (!dir.isDirectory()) return error("no such project: " + id);
            File[] all = projectsRoot.listFiles();
            int dirs = 0;
            if (all != null) for (File f : all) if (f.isDirectory()) dirs += 1;
            if (dirs <= 1) return error("keep at least one project");
            deleteTree(dir);
            if (id.equals(currentId)) {
                File[] left = projectsRoot.listFiles();
                File next = left != null && left.length > 0 ? left[0] : new File(projectsRoot, "my-project");
                if (!next.exists()) next.mkdirs();
                currentId = next.getName();
                root = next;
                state().edit().putString("project", currentId).apply();
            }
            JSONObject result = new JSONObject();
            result.put("ok", true);
            result.put("id", currentId);
            return result.toString();
        } catch (Exception err) {
            return error(err.getMessage());
        }
    }

    @JavascriptInterface
    public String renameProject(String id, String next) {
        try {
            File from = projectDir(id);
            if (!from.isDirectory()) return error("no such project: " + id);
            File to = projectDir(next);
            if (to.exists()) return error("a project called " + to.getName() + " already exists");
            if (!from.renameTo(to)) return error("could not rename the project");
            if (id.equals(currentId)) {
                currentId = to.getName();
                root = to;
                state().edit().putString("project", currentId).apply();
            }
            JSONObject result = new JSONObject();
            result.put("ok", true);
            result.put("id", to.getName());
            return result.toString();
        } catch (Exception err) {
            return error(err.getMessage());
        }
    }

    @JavascriptInterface
    public String mkdir(String path) {
        try {
            File dir = resolve(path);
            if (!dir.exists() && !dir.mkdirs()) return error("could not create " + path);
            JSONObject result = new JSONObject();
            result.put("ok", true);
            return result.toString();
        } catch (Exception err) {
            return error(err.getMessage());
        }
    }

    /* ------------------------------------------------------------------ keys */

    @JavascriptInterface
    public String saveKey(String provider, String value) {
        try {
            if (value == null || value.trim().isEmpty()) return error("empty key");
            prefs().edit().putString(provider, encrypt(value.trim())).apply();
            JSONObject result = new JSONObject();
            result.put("ok", true);
            return result.toString();
        } catch (Exception err) {
            return error(err.getMessage());
        }
    }

    @JavascriptInterface
    public String loadKey(String provider) {
        try {
            String stored = prefs().getString(provider, null);
            JSONObject result = new JSONObject();
            result.put("ok", true);
            result.put("key", stored == null ? "" : decrypt(stored));
            return result.toString();
        } catch (Exception err) {
            return error(err.getMessage());
        }
    }

    @JavascriptInterface
    public String deleteKey(String provider) {
        try {
            prefs().edit().remove(provider).apply();
            JSONObject result = new JSONObject();
            result.put("ok", true);
            return result.toString();
        } catch (Exception err) {
            return error(err.getMessage());
        }
    }

    private SharedPreferences prefs() {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private SecretKey masterKey() throws Exception {
        KeyStore keys = KeyStore.getInstance("AndroidKeyStore");
        keys.load(null);
        if (keys.containsAlias(KEY_ALIAS)) {
            KeyStore.SecretKeyEntry entry = (KeyStore.SecretKeyEntry) keys.getEntry(KEY_ALIAS, null);
            return entry.getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(
                KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return generator.generateKey();
    }

    private String encrypt(String plain) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, masterKey());
        byte[] iv = cipher.getIV();
        byte[] body = cipher.doFinal(plain.getBytes(StandardCharsets.UTF_8));
        byte[] packed = new byte[1 + iv.length + body.length];
        packed[0] = (byte) iv.length;
        System.arraycopy(iv, 0, packed, 1, iv.length);
        System.arraycopy(body, 0, packed, 1 + iv.length, body.length);
        return Base64.encodeToString(packed, Base64.NO_WRAP);
    }

    private String decrypt(String stored) throws Exception {
        byte[] packed = Base64.decode(stored, Base64.NO_WRAP);
        int ivLength = packed[0] & 0xff;
        byte[] iv = new byte[ivLength];
        byte[] body = new byte[packed.length - 1 - ivLength];
        System.arraycopy(packed, 1, iv, 0, ivLength);
        System.arraycopy(packed, 1 + ivLength, body, 0, body.length);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, masterKey(), new GCMParameterSpec(128, iv));
        return new String(cipher.doFinal(body), StandardCharsets.UTF_8);
    }

    /* -------------------------------------------------- local file server */

    /**
     * Serves the current project on 127.0.0.1 only, so "open in browser" hands a
     * real URL to the phone's browser and relative links inside the page work.
     */
    @JavascriptInterface
    public String startServer() {
        try {
            if (fileServer == null || fileServer.isClosed()) {
                fileServer = new ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"));
                fileServerPort = fileServer.getLocalPort();
                final ServerSocket bound = fileServer;
                Thread thread = new Thread(() -> {
                    while (!bound.isClosed()) {
                        try (Socket client = bound.accept()) {
                            serveFile(client);
                        } catch (Exception ignored) {
                            // one bad request must never stop the server
                        }
                    }
                }, "kestrel-file-server");
                thread.setDaemon(true);
                thread.start();
            }
            JSONObject result = new JSONObject();
            result.put("ok", true);
            result.put("port", fileServerPort);
            result.put("url", "http://127.0.0.1:" + fileServerPort + "/");
            return result.toString();
        } catch (Exception err) {
            return error("could not start the file server: " + err.getMessage());
        }
    }

    private void serveFile(Socket client) throws Exception {
        java.io.BufferedReader reader = new java.io.BufferedReader(
                new java.io.InputStreamReader(client.getInputStream(), StandardCharsets.UTF_8));
        String request = reader.readLine();
        if (request == null) return;
        String[] bits = request.split(" ");
        if (bits.length < 2) return;
        String method = bits[0];
        String target = bits[1];
        OutputStream out = client.getOutputStream();
        if (!"GET".equals(method) && !"HEAD".equals(method)) {
            writeHttp(out, 405, "text/plain", "method not allowed".getBytes(StandardCharsets.UTF_8));
            return;
        }
        int query = target.indexOf('?');
        if (query >= 0) target = target.substring(0, query);
        String relative = URLDecoder.decode(target, "UTF-8");
        while (relative.startsWith("/")) relative = relative.substring(1);
        try {
            File file = resolve(relative);
            if (file.isDirectory()) file = new File(file, "index.html");
            if (!file.isFile()) {
                writeHttp(out, 404, "text/plain", ("not found: " + relative).getBytes(StandardCharsets.UTF_8));
                return;
            }
            byte[] body = readUpTo(file, 8L * 1024 * 1024);
            writeHttp(out, 200, mimeFor(file.getName()), body);
        } catch (Exception err) {
            writeHttp(out, 403, "text/plain", String.valueOf(err.getMessage()).getBytes(StandardCharsets.UTF_8));
        }
    }

    private byte[] readUpTo(File file, long limit) throws Exception {
        int size = (int) Math.min(file.length(), limit);
        byte[] buffer = new byte[size];
        try (FileInputStream in = new FileInputStream(file)) {
            int read = 0;
            while (read < size) {
                int n = in.read(buffer, read, size - read);
                if (n < 0) break;
                read += n;
            }
        }
        return buffer;
    }

    private void writeHttp(OutputStream out, int status, String type, byte[] body) throws Exception {
        String reason = status == 200 ? "OK" : status == 404 ? "Not Found" : status == 405 ? "Method Not Allowed" : "Forbidden";
        String head = "HTTP/1.1 " + status + " " + reason + "\r\n" +
                "Content-Type: " + type + "\r\n" +
                "Content-Length: " + body.length + "\r\n" +
                "Cache-Control: no-store\r\n" +
                "Connection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.UTF_8));
        out.flush();
    }

    private String mimeFor(String name) {
        String lower = name.toLowerCase();
        if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html; charset=utf-8";
        if (lower.endsWith(".css")) return "text/css; charset=utf-8";
        if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript; charset=utf-8";
        if (lower.endsWith(".json")) return "application/json; charset=utf-8";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".gif")) return "image/gif";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".md") || lower.endsWith(".txt")) return "text/plain; charset=utf-8";
        return "application/octet-stream";
    }

    @JavascriptInterface
    public String openInBrowser(String path) {
        try {
            JSONObject started = new JSONObject(startServer());
            if (!started.optBoolean("ok")) return started.toString();
            String clean = path == null ? "" : path.replace('\\', '/');
            while (clean.startsWith("/")) clean = clean.substring(1);
            String url = "http://127.0.0.1:" + fileServerPort + "/" + clean;
            android.content.Intent view = new android.content.Intent(android.content.Intent.ACTION_VIEW, Uri.parse(url));
            view.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(view);
            JSONObject result = new JSONObject();
            result.put("ok", true);
            result.put("url", url);
            return result.toString();
        } catch (Exception err) {
            return error("no browser could be opened: " + err.getMessage());
        }
    }

    /* ------------------------------------------------------- repository import */

    /**
     * Android ships no git, so importing a repository means downloading its archive
     * and unpacking the files into a new project. History and submodules are not
     * fetched; the user gets the current tree of one branch.
     */
    @JavascriptInterface
    public void importRepo(final String owner, final String repo, final String ref, final String callbackId) {
        Thread worker = new Thread(() -> {
            JSONObject out = new JSONObject();
            try {
                if (owner == null || !owner.matches("[A-Za-z0-9._-]{1,64}")) throw new Exception("that owner name is not valid");
                if (repo == null || !repo.matches("[A-Za-z0-9._-]{1,100}")) throw new Exception("that repository name is not valid");
                String branch = ref == null || ref.trim().isEmpty() ? "main" : ref.trim();
                if (!branch.matches("[A-Za-z0-9._/-]{1,120}")) throw new Exception("that branch name is not valid");

                String base = repo.toLowerCase().replaceAll("[^a-z0-9._-]+", "-");
                if (base.isEmpty()) base = "repo";
                File target = new File(projectsRoot, base);
                int suffix = 2;
                while (target.exists()) target = new File(projectsRoot, base + "-" + suffix++);

                File archive = File.createTempFile("kestrel-repo", ".zip", context.getCacheDir());
                int status = downloadArchive(owner, repo, branch, archive);
                if (status == 404 && (ref == null || ref.trim().isEmpty())) {
                    status = downloadArchive(owner, repo, "master", archive);
                    if (status == 200) branch = "master";
                }
                if (status != 200) {
                    archive.delete();
                    throw new Exception("GitHub returned HTTP " + status + " for " + owner + "/" + repo + " (" + branch + ")");
                }

                int[] counts = new int[2];
                unzipInto(archive, target, counts);
                archive.delete();

                currentId = target.getName();
                root = target;
                state().edit().putString("project", currentId).apply();

                out.put("ok", true);
                out.put("project", currentId);
                out.put("branch", branch);
                out.put("files", counts[0]);
                out.put("bytes", counts[1]);
            } catch (Exception err) {
                out = new JSONObject();
                try {
                    out.put("ok", false);
                    out.put("error", err.getMessage() == null ? "the import failed" : err.getMessage());
                } catch (Exception ignored) {
                    // nothing left to report
                }
            }
            emitNative(callbackId, out.toString());
        }, "kestrel-repo-import");
        worker.start();
    }

    private int downloadArchive(String owner, String repo, String branch, File destination) throws Exception {
        String url = "https://codeload.github.com/" + owner + "/" + repo + "/zip/refs/heads/" + branch;
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        try {
            connection.setInstanceFollowRedirects(true);
            connection.setConnectTimeout(30000);
            connection.setReadTimeout(180000);
            connection.setRequestProperty("user-agent", "Kestrel/" + versionName() + " (Android)");
            int status = connection.getResponseCode();
            if (status != 200) return status;
            long total = 0;
            try (InputStream in = connection.getInputStream(); OutputStream file = new FileOutputStream(destination)) {
                byte[] buffer = new byte[16384];
                int read;
                while ((read = in.read(buffer)) != -1) {
                    total += read;
                    if (total > MAX_ARCHIVE) throw new Exception("the repository archive is larger than 40 MB");
                    file.write(buffer, 0, read);
                }
            }
            return 200;
        } finally {
            connection.disconnect();
        }
    }

    private void unzipInto(File archive, File target, int[] counts) throws Exception {
        String rootPath = target.getCanonicalPath();
        if (!target.exists() && !target.mkdirs()) throw new Exception("could not create the project folder");
        try (ZipInputStream zip = new ZipInputStream(new FileInputStream(archive))) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                if (entry.isDirectory()) continue;
                String name = entry.getName().replace('\\', '/');
                int slash = name.indexOf('/');
                if (slash < 0) continue;
                String relative = name.substring(slash + 1);
                if (relative.isEmpty() || relative.startsWith(".git/") || relative.contains("..")) continue;
                if (counts[0] >= 3000) throw new Exception("the repository has more than 3000 files");

                File file = new File(target, relative);
                if (!file.getCanonicalPath().startsWith(rootPath + File.separator)) continue;
                File parent = file.getParentFile();
                if (parent != null && !parent.exists() && !parent.mkdirs()) continue;

                boolean tooBig = false;
                try (OutputStream stream = new FileOutputStream(file)) {
                    byte[] buffer = new byte[16384];
                    int read;
                    long size = 0;
                    while ((read = zip.read(buffer)) != -1) {
                        size += read;
                        if (size > MAX_FILE_IN_ARCHIVE) {
                            tooBig = true;
                            break;
                        }
                        if (counts[1] + read > MAX_EXTRACTED) throw new Exception("the repository is larger than 60 MB");
                        stream.write(buffer, 0, read);
                    }
                    if (tooBig) {
                        stream.close();
                        file.delete();
                        continue;
                    }
                    counts[1] += (int) size;
                }
                counts[0] += 1;
            }
        }
    }

    /* ------------------------------------------------ voice, share, feedback */

    /** Opens the phone's speech recogniser; the words come back on __kestrelDictation. */
    @JavascriptInterface
    public String listen() {
        if (context instanceof MainActivity) {
            ((MainActivity) context).startDictation();
            return "{\"ok\":true}";
        }
        return error("dictation needs the app window");
    }

    @JavascriptInterface
    public String speak(String text) {
        try {
            if (tts == null) {
                tts = new android.speech.tts.TextToSpeech(context, status -> {});
            }
            String clean = text == null ? "" : text;
            if (clean.length() > 4000) clean = clean.substring(0, 4000);
            tts.speak(clean, android.speech.tts.TextToSpeech.QUEUE_FLUSH, null, "kestrel-reply");
            return "{\"ok\":true}";
        } catch (Exception err) {
            return error("speech failed: " + err.getMessage());
        }
    }

    @JavascriptInterface
    public String stopSpeaking() {
        try {
            if (tts != null) tts.stop();
        } catch (Exception ignored) {
            // nothing to stop
        }
        return "{\"ok\":true}";
    }

    @JavascriptInterface
    public String shareText(String text) {
        try {
            android.content.Intent send = new android.content.Intent(android.content.Intent.ACTION_SEND);
            send.setType("text/plain");
            send.putExtra(android.content.Intent.EXTRA_TEXT, text == null ? "" : text);
            send.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(android.content.Intent.createChooser(send, "Share chat"));
            return "{\"ok\":true}";
        } catch (Exception err) {
            return error("nothing on this phone could share it: " + err.getMessage());
        }
    }

    @JavascriptInterface
    public String vibrate(int millis) {
        try {
            android.os.Vibrator vibrator = (android.os.Vibrator) context.getSystemService(Context.VIBRATOR_SERVICE);
            if (vibrator != null && vibrator.hasVibrator()) {
                vibrator.vibrate(Math.min(Math.max(millis, 8), 60));
            }
            return "{\"ok\":true}";
        } catch (Exception err) {
            return error(String.valueOf(err.getMessage()));
        }
    }

    /* -------------------------------------------------------------- file picker */

    /** Opens the system picker; the result comes back through handlePicked(). */
    @JavascriptInterface
    public void pickFiles(String kind, String callbackId) {
        if (context instanceof MainActivity) {
            ((MainActivity) context).startFilePicker(kind, callbackId);
        } else {
            emitNative(callbackId, "{\"ok\":false,\"error\":\"the file picker needs the app window\"}");
        }
    }

    /** Copies whatever the system picker returns into uploads/ of the current project. */
    void handlePicked(String callbackId, List<Uri> uris) {
        JSONObject out = new JSONObject();
        try {
            File dir = new File(root, "uploads");
            if (!dir.exists() && !dir.mkdirs()) throw new Exception("could not create the uploads folder");
            JSONArray saved = new JSONArray();
            for (Uri uri : uris) {
                String name = displayName(uri);
                File target = new File(dir, name);
                int n = 2;
                while (target.exists()) {
                    int dot = name.lastIndexOf('.');
                    String base = dot > 0 ? name.substring(0, dot) : name;
                    String ext = dot > 0 ? name.substring(dot) : "";
                    target = new File(dir, base + "-" + n++ + ext);
                }
                try (InputStream in = context.getContentResolver().openInputStream(uri);
                     OutputStream stream = new FileOutputStream(target)) {
                    if (in == null) continue;
                    byte[] buffer = new byte[16384];
                    int read;
                    while ((read = in.read(buffer)) != -1) stream.write(buffer, 0, read);
                }
                saved.put("uploads/" + target.getName());
            }
            out.put("ok", true);
            out.put("paths", saved);
        } catch (Exception err) {
            out = new JSONObject();
            try {
                out.put("ok", false);
                out.put("error", String.valueOf(err.getMessage()));
            } catch (Exception ignored) {
                // nothing left to report
            }
        }
        emitNative(callbackId, out.toString());
    }

    private String displayName(Uri uri) {
        String name = null;
        try (android.database.Cursor cursor = context.getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                if (index >= 0) name = cursor.getString(index);
            }
        } catch (Exception ignored) {
            // fall back to the path
        }
        if (name == null) name = uri.getLastPathSegment();
        if (name == null) name = "file";
        name = name.replaceAll("[\\\\/:*?\"<>|]", "-").trim();
        return name.isEmpty() ? "file" : name;
    }

    private void emitNative(String callbackId, String json) {
        final String script = "window.__kestrelNative && window.__kestrelNative(" +
                JSONObject.quote(callbackId == null ? "" : callbackId) + "," +
                JSONObject.quote(json == null ? "{}" : json) + ")";
        if (web == null) return;
        web.post(() -> {
            if (web != null) web.evaluateJavascript(script, null);
        });
    }

    void close() {
        try {
            if (fileServer != null) fileServer.close();
        } catch (Exception ignored) {
            // already closed
        }
        fileServer = null;
        try {
            if (tts != null) {
                tts.stop();
                tts.shutdown();
            }
        } catch (Exception ignored) {
            // already shut down
        }
        tts = null;
    }

    /* ------------------------------------------------------------------ http */

    @JavascriptInterface
    public void httpStart(final String id, final String method, final String url, final String headersJson, final String body) {
        Thread worker = new Thread(() -> {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(url).openConnection();
                live.put(id, connection);
                connection.setRequestMethod(method == null || method.isEmpty() ? "GET" : method);
                connection.setConnectTimeout(30000);
                connection.setReadTimeout(180000);
                connection.setRequestProperty("accept", "text/event-stream");
                connection.setRequestProperty("accept-encoding", "identity");
                connection.setRequestProperty("user-agent", "Kestrel/" + versionName() + " (Android)");
                JSONObject headers = new JSONObject(headersJson == null || headersJson.isEmpty() ? "{}" : headersJson);
                for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
                    String name = it.next();
                    connection.setRequestProperty(name, headers.getString(name));
                }
                if (body != null && !body.isEmpty()) {
                    connection.setDoOutput(true);
                    byte[] payload = body.getBytes(StandardCharsets.UTF_8);
                    connection.setFixedLengthStreamingMode(payload.length);
                    try (OutputStream out = connection.getOutputStream()) {
                        out.write(payload);
                    }
                }
                int status = connection.getResponseCode();
                emit(id, "status", String.valueOf(status));
                InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                if (stream == null) stream = connection.getErrorStream();
                if (stream != null) {
                    Reader reader = new InputStreamReader(stream, StandardCharsets.UTF_8);
                    char[] buffer = new char[2048];
                    int read;
                    while ((read = reader.read(buffer)) != -1) {
                        if (!live.containsKey(id)) break;
                        emit(id, "chunk", new String(buffer, 0, read));
                    }
                    reader.close();
                }
                emit(id, "end", "");
            } catch (Exception err) {
                emit(id, "error", String.valueOf(err.getMessage()));
            } finally {
                live.remove(id);
                if (connection != null) connection.disconnect();
            }
        }, "kestrel-http");
        worker.start();
    }

    @JavascriptInterface
    public void httpAbort(String id) {
        HttpURLConnection connection = live.remove(id);
        if (connection != null) connection.disconnect();
    }

    private void emit(String id, String kind, String payload) {
        final String script =
                "window.__kestrelHttp && window.__kestrelHttp(" +
                        JSONObject.quote(id) + "," +
                        JSONObject.quote(kind) + "," +
                        JSONObject.quote(payload == null ? "" : payload) + ")";
        if (web == null) return;
        web.post(() -> {
            if (web != null) web.evaluateJavascript(script, null);
        });
    }

    /* ------------------------------------------------------------------ info */

    @JavascriptInterface
    public String deviceInfo() {
        try {
            JSONObject info = new JSONObject();
            info.put("model", Build.MODEL);
            info.put("manufacturer", Build.MANUFACTURER);
            info.put("release", Build.VERSION.RELEASE);
            info.put("sdk", Build.VERSION.SDK_INT);
            info.put("app", versionName());
            info.put("keystore", "AndroidKeyStore/AES-GCM");
            return info.toString();
        } catch (Exception err) {
            return "{\"model\":\"unknown\",\"release\":\"?\",\"sdk\":0}";
        }
    }

    private String versionName() {
        try {
            return context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName;
        } catch (Exception err) {
            return "1.0.0";
        }
    }

    private String error(String message) {
        try {
            JSONObject out = new JSONObject();
            out.put("ok", false);
            out.put("error", message == null ? "native error" : message);
            return out.toString();
        } catch (Exception err) {
            return "{\"ok\":false,\"error\":\"native error\"}";
        }
    }
}
