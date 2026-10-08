#include <gtk/gtk.h>
#include <webkit2/webkit2.h>
#include <glib.h>
#include <atomic>
#include <cerrno>
#include <cstring>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#include <thread>
#include <mutex>
#include <string>
#include <vector>
#include <map>
#include <algorithm>
#include <cctype>

namespace fs = std::filesystem;

struct Tab {
    std::string id;
    GtkWidget* container = nullptr;
    WebKitWebView* view = nullptr;
    GtkWidget* label = nullptr;
    bool loading = false;
    gint64 load_started_ms = 0;
    gint64 last_change_ms = 0;
    std::string error;
};

static GtkWidget* g_window = nullptr;
static GtkWidget* g_notebook = nullptr;
static WebKitWebContext* g_context = nullptr;
static WebKitWebsiteDataManager* g_data_manager = nullptr;
static std::map<std::string, Tab> g_tabs;
static std::string g_active;
static std::atomic<bool> g_running{true};
static int g_control_port = 9333;
static int g_control_fd = -1;
static std::mutex g_command_mutex;
static std::string g_profile;
static std::string g_downloads;
static const gint64 LOAD_TIMEOUT_MS = 30000;

static gint64 now_ms() {
    return g_get_monotonic_time() / 1000;
}

static std::string json_escape(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 16);
    for (unsigned char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) out += ' ';
                else out += static_cast<char>(c);
        }
    }
    return out;
}

static std::string shell_safe_id(const std::string& id) {
    std::string out;
    for (char c : id) if (g_ascii_isalnum(c) || c == '-' || c == '_') out += c;
    return out.empty() ? "tab" : out;
}

static Tab* tab_for_view(WebKitWebView* view) {
    for (auto& [id, tab] : g_tabs) if (tab.view == view) return &tab;
    return nullptr;
}

static Tab* active_tab() {
    auto it = g_tabs.find(g_active);
    return it == g_tabs.end() ? nullptr : &it->second;
}

static std::string current_uri(Tab& tab);

static void update_tab_label(Tab& tab) {
    const gchar* title = webkit_web_view_get_title(WEBKIT_WEB_VIEW(tab.view));
    std::string text = (title && *title) ? title : "New Tab";
    if (text.size() > 34) text.resize(34);
    gtk_label_set_text(GTK_LABEL(tab.label), text.c_str());
}

static void set_error(Tab& tab, const std::string& error) {
    tab.error = error;
    tab.last_change_ms = now_ms();
}

static void on_load_changed(WebKitWebView* view, WebKitLoadEvent event, gpointer) {
    Tab* tab = tab_for_view(view);
    if (!tab) return;
    tab->last_change_ms = now_ms();
    if (event == WEBKIT_LOAD_STARTED) {
        tab->loading = true;
        tab->load_started_ms = now_ms();
        tab->error.clear();
    } else if (event == WEBKIT_LOAD_COMMITTED) {
        tab->loading = true;
    } else if (event == WEBKIT_LOAD_FINISHED) {
        tab->loading = false;
        update_tab_label(*tab);
        const std::string uri = current_uri(*tab);
        if (uri.empty()) tab->error = "Blank page / no response";
    }
}

static gboolean on_load_failed(WebKitWebView* view, WebKitLoadEvent, const gchar* failing_uri, GError* error, gpointer) {
    Tab* tab = tab_for_view(view);
    if (tab) {
        tab->loading = false;
        set_error(*tab, error && error->message ? error->message : "Navigation failed");
    }
    (void)failing_uri;
    return FALSE;
}

static gboolean on_load_failed_tls(WebKitWebView* view, const gchar*, GTlsCertificate*, GTlsCertificateFlags, gpointer) {
    Tab* tab = tab_for_view(view);
    if (tab) {
        tab->loading = false;
        set_error(*tab, "TLS certificate error");
    }
    return TRUE;
}

static void on_web_process_terminated(WebKitWebView* view, WebKitWebProcessTerminationReason reason, gpointer) {
    Tab* tab = tab_for_view(view);
    if (!tab) return;
    tab->error = (reason == WEBKIT_WEB_PROCESS_EXCEEDED_MEMORY_LIMIT) ? "Web process exceeded memory limit" : "Web process terminated";
    tab->loading = false;
    tab->last_change_ms = now_ms();
}

static bool policy_bool(const std::string& origin, const std::string& key) {
    std::ifstream in(fs::path(g_profile) / "security-settings.json");
    if (!in) return false;
    std::string raw((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    const std::string needle = "\"" + origin + "\"";
    auto at = raw.find(needle);
    if (at == std::string::npos) return false;
    auto end = raw.find('}', at);
    if (end == std::string::npos) return false;
    auto k = raw.find("\"" + key + "\"", at);
    if (k == std::string::npos || k > end) return false;
    auto colon = raw.find(':', k);
    if (colon == std::string::npos || colon > end) return false;
    auto val = raw.find_first_not_of(" \t\r\n", colon + 1);
    return val != std::string::npos && raw.compare(val, 4, "true") == 0;
}
static bool global_policy_bool(const std::string& key, bool fallback) {
    std::ifstream in(fs::path(g_profile) / "security-settings.json");
    if (!in) return fallback;
    std::string raw((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    auto k = raw.find("\"" + key + "\"");
    if (k == std::string::npos) return fallback;
    auto colon = raw.find(':', k);
    if (colon == std::string::npos) return fallback;
    auto val = raw.find_first_not_of(" \\t\\r\\n", colon + 1);
    if (val == std::string::npos) return fallback;
    if (raw.compare(val, 4, "true") == 0) return true;
    if (raw.compare(val, 5, "false") == 0) return false;
    return fallback;
}
static std::string view_origin(WebKitWebView* view) {
    const gchar* uri = webkit_web_view_get_uri(view);
    if (!uri) return "";
    GError* error = nullptr;
    GUri* parsed = g_uri_parse(uri, G_URI_FLAGS_NONE, &error);
    if (!parsed) { if (error) g_error_free(error); return ""; }
    const char* scheme = g_uri_get_scheme(parsed);
    const char* host = g_uri_get_host(parsed);
    std::string out;
    if (scheme && host && (g_str_equal(scheme, "http") || g_str_equal(scheme, "https"))) {
        out = scheme; out += "://"; out += host;
        int port = g_uri_get_port(parsed);
        if (port > 0 && !((g_str_equal(scheme,"http") && port == 80) || (g_str_equal(scheme,"https") && port == 443))) out += ":" + std::to_string(port);
    }
    g_uri_unref(parsed);
    return out;
}
static gboolean on_permission_request(WebKitWebView* view, WebKitPermissionRequest* request, gpointer) {
    const std::string origin = view_origin(view);
    const char* type = g_type_name(G_OBJECT_TYPE(request));
    bool allow = false;
    if (type && origin.size()) {
        if (strstr(type, "Geolocation")) allow = policy_bool(origin, "location");
        else if (strstr(type, "Notification")) allow = policy_bool(origin, "notifications");
        else if (strstr(type, "UserMedia")) allow = policy_bool(origin, "camera") && policy_bool(origin, "microphone");
    }
    if (allow) webkit_permission_request_allow(request);
    else webkit_permission_request_deny(request);
    return TRUE;
}

static gboolean on_enter_fullscreen(WebKitWebView*, gpointer) {
    if (g_window) gtk_window_fullscreen(GTK_WINDOW(g_window));
    return TRUE;
}

static gboolean on_leave_fullscreen(WebKitWebView*, gpointer) {
    if (g_window) gtk_window_unfullscreen(GTK_WINDOW(g_window));
    return TRUE;
}

static gboolean on_decide_policy(WebKitWebView*, WebKitPolicyDecision* decision, WebKitPolicyDecisionType type, gpointer) {
    if (type == WEBKIT_POLICY_DECISION_TYPE_NEW_WINDOW_ACTION) {
        // Popups are blocked by default; no untrusted page may open an unmanaged window.
        webkit_policy_decision_ignore(decision);
        return TRUE;
    }
    if (type != WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION) return FALSE;
    WebKitNavigationAction* action = webkit_navigation_policy_decision_get_navigation_action(WEBKIT_NAVIGATION_POLICY_DECISION(decision));
    WebKitURIRequest* request = action ? webkit_navigation_action_get_request(action) : nullptr;
    const gchar* raw_uri = request ? webkit_uri_request_get_uri(request) : nullptr;
    const gchar* scheme_raw = raw_uri ? g_uri_parse_scheme(raw_uri) : nullptr;
    std::string scheme = scheme_raw ? scheme_raw : "";
    g_free((gpointer)scheme_raw);
    std::transform(scheme.begin(), scheme.end(), scheme.begin(), [](unsigned char c) { return static_cast<char>(g_ascii_tolower(c)); });
    bool allowed = scheme == "http" || scheme == "https" || scheme == "about" || scheme == "data" || scheme == "blob";
    if ((scheme == "http" || scheme == "https") && raw_uri) {
        GError* parse_error = nullptr;
        GUri* parsed = g_uri_parse(raw_uri, G_URI_FLAGS_NONE, &parse_error);
        if (parsed) {
            const char* host_raw = g_uri_get_host(parsed);
            std::string host = host_raw ? host_raw : "";
            std::transform(host.begin(), host.end(), host.begin(), [](unsigned char c) { return static_cast<char>(g_ascii_tolower(c)); });
            bool private_host = host == "localhost" || host == "::1" || host == "0.0.0.0" || host.rfind("127.",0)==0 || host.rfind("10.",0)==0 || host.rfind("192.168.",0)==0 || host.rfind("169.254.",0)==0 || host.rfind("172.16.",0)==0 || host.rfind("172.17.",0)==0 || host.rfind("172.18.",0)==0 || host.rfind("172.19.",0)==0 || host.rfind("172.2",0)==0 || host.rfind("172.30.",0)==0 || host.rfind("172.31.",0)==0 || host.size()>6 && (host.rfind("fc",0)==0 || host.rfind("fd",0)==0 || host.rfind("fe80:",0)==0);
            if (private_host && global_policy_bool("blockPrivateNetwork", true)) allowed = false;
            g_uri_unref(parsed);
        }
        if (parse_error) g_error_free(parse_error);
    }
    if (scheme == "file" && raw_uri) {
        GError* error = nullptr;
        gchar* profile_uri = g_filename_to_uri(g_profile.c_str(), nullptr, &error);
        if (profile_uri) {
            std::string prefix = profile_uri;
            if (!prefix.empty() && prefix.back() != '/') prefix += '/';
            allowed = std::string(raw_uri).rfind(prefix, 0) == 0;
            g_free(profile_uri);
        }
        if (error) g_error_free(error);
    }
    if (allowed) webkit_policy_decision_use(decision);
    else webkit_policy_decision_ignore(decision);
    return TRUE;
}

static void on_download_decide_destination(WebKitDownload* download, const gchar* suggested_filename, gpointer) {
    fs::create_directories(g_downloads);
    std::string name = suggested_filename && *suggested_filename ? suggested_filename : "download";
    for (char& c : name) if (c == '/' || c == '\\' || c == ':') c = '_';
    fs::path dest = fs::path(g_downloads) / name;
    int n = 1;
    while (fs::exists(dest)) {
        dest = fs::path(g_downloads) / (std::to_string(n++) + "-" + name);
    }
    GError* error = nullptr;
    gchar* uri = g_filename_to_uri(dest.c_str(), nullptr, &error);
    if (uri) { webkit_download_set_destination(download, uri); g_free(uri); }
    if (error) g_error_free(error);
}

static void on_download_started(WebKitWebContext*, WebKitDownload* download, gpointer) {
    std::ifstream in(fs::path(g_profile) / "security-settings.json");
    std::string raw((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    if (raw.find("\"downloads\": \"block\"") != std::string::npos) {
        webkit_download_cancel(download);
        return;
    }
    g_signal_connect(download, "decide-destination", G_CALLBACK(on_download_decide_destination), nullptr);
}

static void on_title_changed(GObject* object, GParamSpec*, gpointer) {
    Tab* tab = tab_for_view(WEBKIT_WEB_VIEW(object));
    if (tab) update_tab_label(*tab);
}

static void on_uri_changed(GObject* object, GParamSpec*, gpointer) {
    Tab* tab = tab_for_view(WEBKIT_WEB_VIEW(object));
    if (tab) tab->last_change_ms = now_ms();
}

static Tab* create_tab(const std::string& id, const std::string& uri, bool private_mode = false) {
    if (g_tabs.count(id)) return &g_tabs[id];
    WebKitWebContext* context = g_context;
    if (private_mode) context = webkit_web_context_new_ephemeral();
    WebKitWebView* view = WEBKIT_WEB_VIEW(webkit_web_view_new_with_context(context));
    if (private_mode) g_object_unref(context);

    WebKitSettings* settings = webkit_settings_new_with_settings(
        "enable-javascript", TRUE,
        "enable-media", TRUE,
        "enable-webgl", TRUE,
        "enable-accelerated-2d-canvas", TRUE,
        "enable-smooth-scrolling", TRUE,
        "enable-html5-database", TRUE,
        "enable-html5-local-storage", TRUE,
        "enable-site-specific-quirks", TRUE,
        "enable-fullscreen", TRUE,
        "javascript-can-access-clipboard", TRUE,
        "allow-top-navigation-to-data-urls", FALSE,
        "allow-universal-access-from-file-urls", FALSE,
        "allow-file-access-from-file-urls", FALSE,
        "enable-mediasource", TRUE,
        "enable-webaudio", TRUE,
        "enable-webrtc", TRUE,
        "enable-encrypted-media", TRUE,
        "allow-running-of-insecure-content", FALSE,
        "enable-media-stream", std::getenv("SOLOHOST_ALLOW_MEDIA_STREAM") && std::string(std::getenv("SOLOHOST_ALLOW_MEDIA_STREAM")) == "1",
        "user-agent", "SoloHostBrowser/7.1 WebKit",
        nullptr);
    // Media defaults: user-gesture required avoids noisy surprise autoplay.
    // Set SOLOHOST_MEDIA_AUTOPLAY=1 only for deployments that explicitly want autoplay.
    const char* autoplay = std::getenv("SOLOHOST_MEDIA_AUTOPLAY");
    webkit_settings_set_media_playback_requires_user_gesture(settings, !(autoplay && std::string(autoplay) == "1"));
    webkit_settings_set_media_playback_allows_inline(settings, TRUE);
    webkit_web_view_set_settings(view, settings);
    g_object_unref(settings);

    GtkWidget* label = gtk_label_new("New Tab");
    GtkWidget* scroller = gtk_scrolled_window_new(nullptr, nullptr);
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(scroller), GTK_POLICY_AUTOMATIC, GTK_POLICY_AUTOMATIC);
    gtk_container_add(GTK_CONTAINER(scroller), GTK_WIDGET(view));
    gtk_widget_show_all(scroller);
    int page = gtk_notebook_append_page(GTK_NOTEBOOK(g_notebook), scroller, label);
    gtk_notebook_set_tab_reorderable(GTK_NOTEBOOK(g_notebook), scroller, TRUE);
    gtk_notebook_set_current_page(GTK_NOTEBOOK(g_notebook), page);

    Tab tab;
    tab.id = id;
    tab.container = scroller;
    tab.view = view;
    tab.label = label;
    tab.last_change_ms = now_ms();
    g_tabs[id] = tab;
    // Store the actual WebView in the scroller's child for easy lookup.
    g_signal_connect(view, "load-changed", G_CALLBACK(on_load_changed), nullptr);
    g_signal_connect(view, "load-failed", G_CALLBACK(on_load_failed), nullptr);
    g_signal_connect(view, "load-failed-with-tls-errors", G_CALLBACK(on_load_failed_tls), nullptr);
    g_signal_connect(view, "web-process-terminated", G_CALLBACK(on_web_process_terminated), nullptr);
    g_signal_connect(view, "permission-request", G_CALLBACK(on_permission_request), nullptr);
    g_signal_connect(view, "enter-fullscreen", G_CALLBACK(on_enter_fullscreen), nullptr);
    g_signal_connect(view, "leave-fullscreen", G_CALLBACK(on_leave_fullscreen), nullptr);
    g_signal_connect(view, "decide-policy", G_CALLBACK(on_decide_policy), nullptr);
    g_signal_connect(view, "notify::title", G_CALLBACK(on_title_changed), nullptr);
    g_signal_connect(view, "notify::uri", G_CALLBACK(on_uri_changed), nullptr);
    g_active = id;
    if (!uri.empty()) webkit_web_view_load_uri(view, uri.c_str());
    return &g_tabs[id];
}

static WebKitWebView* view_of(Tab& tab) {
    return tab.view;
}

static std::string current_uri(Tab& tab) {
    WebKitWebView* view = view_of(tab);
    const gchar* uri = view ? webkit_web_view_get_uri(view) : nullptr;
    return uri ? uri : "";
}

static std::string current_title(Tab& tab) {
    WebKitWebView* view = view_of(tab);
    const gchar* title = view ? webkit_web_view_get_title(view) : nullptr;
    return title ? title : "";
}

static void close_tab(const std::string& id) {
    auto it = g_tabs.find(id);
    if (it == g_tabs.end()) return;
    int page = gtk_notebook_page_num(GTK_NOTEBOOK(g_notebook), it->second.container);
    if (page >= 0) gtk_notebook_remove_page(GTK_NOTEBOOK(g_notebook), page);
    g_tabs.erase(it);
    if (g_tabs.empty()) create_tab("home", "about:blank");
    if (!g_tabs.count(g_active)) g_active = g_tabs.begin()->first;
}

static void activate_tab(const std::string& id) {
    auto it = g_tabs.find(id);
    if (it == g_tabs.end()) return;
    g_active = id;
    int page = gtk_notebook_page_num(GTK_NOTEBOOK(g_notebook), it->second.container);
    if (page >= 0) gtk_notebook_set_current_page(GTK_NOTEBOOK(g_notebook), page);
}

static std::string state_json() {
    std::string out = "{\"ok\":true,\"engine\":\"webkit\",\"active\":\"" + json_escape(g_active) + "\",\"tabs\":[";
    bool first = true;
    for (auto& [id, tab] : g_tabs) {
        if (!first) out += ',';
        first = false;
        const bool responsive = tab.view ? webkit_web_view_get_is_web_process_responsive(tab.view) : false;
        out += "{\"id\":\"" + json_escape(id) + "\",\"url\":\"" + json_escape(current_uri(tab)) + "\",\"title\":\"" + json_escape(current_title(tab)) + "\",\"loading\":" + (tab.loading ? "true" : "false") + ",\"responsive\":" + (responsive ? "true" : "false") + ",\"error\":\"" + json_escape(tab.error) + "\"}";
    }
    out += "]}";
    return out;
}

static std::string command_on_main(const std::string& command) {
    auto split = command.find(' ');
    std::string op = split == std::string::npos ? command : command.substr(0, split);
    std::string arg = split == std::string::npos ? "" : command.substr(split + 1);
    if (op == "CREATE") {
        std::string id = arg.empty() ? "tab-" + std::to_string(now_ms()) : arg;
        create_tab(id, "about:blank");
    } else if (op == "ACTIVATE") {
        activate_tab(arg);
    } else if (op == "CLOSE") {
        close_tab(arg);
    } else if (op == "NAVIGATE") {
        Tab* tab = active_tab();
        if (!tab) tab = create_tab("home", "about:blank");
        WebKitWebView* view = view_of(*tab);
        if (view && !arg.empty()) webkit_web_view_load_uri(view, arg.c_str());
    } else if (op == "BACK") {
        if (auto* tab = active_tab()) if (auto* view = view_of(*tab)) webkit_web_view_go_back(view);
    } else if (op == "FORWARD") {
        if (auto* tab = active_tab()) if (auto* view = view_of(*tab)) webkit_web_view_go_forward(view);
    } else if (op == "RELOAD") {
        if (auto* tab = active_tab()) if (auto* view = view_of(*tab)) webkit_web_view_reload(view);
    } else if (op == "STOP") {
        if (auto* tab = active_tab()) if (auto* view = view_of(*tab)) webkit_web_view_stop_loading(view);
    } else if (op == "ZOOM") {
        if (auto* tab = active_tab()) if (auto* view = view_of(*tab)) webkit_web_view_set_zoom_level(view, std::max(0.5, std::min(3.0, std::atof(arg.c_str()))));
    } else if (op == "FULLSCREEN") {
        if (arg == "1") gtk_window_fullscreen(GTK_WINDOW(g_window));
        else gtk_window_unfullscreen(GTK_WINDOW(g_window));
    } else if (op == "FIND") {
        if (auto* tab = active_tab()) if (auto* view = view_of(*tab)) {
            WebKitFindController* finder = webkit_web_view_get_find_controller(view);
            if (!arg.empty()) webkit_find_controller_search(finder, arg.c_str(), WEBKIT_FIND_OPTIONS_CASE_INSENSITIVE | WEBKIT_FIND_OPTIONS_WRAP_AROUND, 100);
        }
    } else if (op == "FINDNEXT") {
        if (auto* tab = active_tab()) if (auto* view = view_of(*tab)) webkit_find_controller_search_next(webkit_web_view_get_find_controller(view));
    } else if (op == "FINDPREV") {
        if (auto* tab = active_tab()) if (auto* view = view_of(*tab)) webkit_find_controller_search_previous(webkit_web_view_get_find_controller(view));
    } else if (op == "MEDIA") {
        if (auto* tab = active_tab()) if (auto* view = view_of(*tab)) {
            const auto sep = arg.find(' ');
            const std::string action = sep == std::string::npos ? arg : arg.substr(0, sep);
            const std::string value = sep == std::string::npos ? "" : arg.substr(sep + 1);
            std::string script;
            if (action == "play") {
                // The shell button is an explicit user intent; relax the per-view gesture gate
                // only after that click so media playback can begin from this control.
                WebKitSettings* settings = webkit_web_view_get_settings(view);
                webkit_settings_set_media_playback_requires_user_gesture(settings, FALSE);
                script = "document.querySelectorAll('video,audio').forEach(m=>{if(m.paused)m.play().catch(()=>{});else m.pause()});";
            }
            else if (action == "mute") script = "document.querySelectorAll('video,audio').forEach(m=>m.muted=!m.muted);";
            else if (action == "volume") {
                char* end = nullptr; double volume = std::strtod(value.c_str(), &end);
                if (end && *end == '\0' && volume >= 0.0 && volume <= 1.0) {
                    script = "document.querySelectorAll('video,audio').forEach(m=>{m.volume=" + value + ";if(m.volume>0)m.muted=false});";
                }
            } else if (action == "captions") script = "document.querySelectorAll('video,audio').forEach(m=>{const ts=[...m.textTracks].filter(t=>t.kind==='subtitles'||t.kind==='captions');if(ts.length){const on=ts.some(t=>t.mode==='showing');ts.forEach(t=>t.mode=on?'disabled':'showing')}});";
            else if (action == "fullscreen") script = "(()=>{const d=document.documentElement;const on=d.classList.toggle('solohost-media-fullscreen');let st=document.getElementById('solohost-media-fullscreen-style');if(on&&!st){st=document.createElement('style');st.id='solohost-media-fullscreen-style';st.textContent='.solohost-media-fullscreen video{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;object-fit:contain!important;background:#000!important;z-index:2147483647!important}';d.appendChild(st)}if(on){const v=[...document.querySelectorAll('video')].find(x=>x.readyState>0)||document.querySelector('video');if(v)v.scrollIntoView({block:'center'})}})();";
            if (!script.empty()) webkit_web_view_run_javascript(view, script.c_str(), nullptr, nullptr, nullptr);
        }
    } else if (op == "QUIT") {
        g_running = false;
        gtk_main_quit();
    }
    return state_json();
}

static void control_server() {
    g_control_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (g_control_fd < 0) return;
    int one = 1;
    setsockopt(g_control_fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons(g_control_port);
    if (bind(g_control_fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0 || listen(g_control_fd, 16) < 0) {
        close(g_control_fd); g_control_fd = -1; return;
    }
    while (g_running) {
        int client = accept(g_control_fd, nullptr, nullptr);
        if (client < 0) { if (errno == EINTR) continue; break; }
        char buf[16384];
        ssize_t n = read(client, buf, sizeof(buf) - 1);
        if (n > 0) {
            buf[n] = '\0';
            std::string input(buf);
            while (!input.empty() && (input.back() == '\n' || input.back() == '\r')) input.pop_back();
            if (!input.empty()) {
                std::lock_guard<std::mutex> lock(g_command_mutex);
                std::string* copy = new std::string(input);
                g_idle_add([](gpointer data) -> gboolean {
                    std::string* cmd = static_cast<std::string*>(data);
                    // The command result is intentionally written through a one-shot response file.
                    // The Node side can poll STATE while the UI remains non-blocking.
                    std::string result = command_on_main(*cmd);
                    std::ofstream f("/tmp/solohost-webkit-last-state.json", std::ios::trunc);
                    f << result;
                    delete cmd;
                    return G_SOURCE_REMOVE;
                }, copy);
                const char* ok = "OK\n";
                write(client, ok, 3);
            }
        }
        close(client);
    }
    if (g_control_fd >= 0) close(g_control_fd);
    g_control_fd = -1;
}

static gboolean watchdog(gpointer) {
    const gint64 now = now_ms();
    for (auto& [id, tab] : g_tabs) {
        if (tab.loading && tab.load_started_ms > 0 && now - tab.load_started_ms > LOAD_TIMEOUT_MS) {
            WebKitWebView* view = view_of(tab);
            if (view) webkit_web_view_stop_loading(view);
            tab.loading = false;
            set_error(tab, "Navigation timeout");
        }
    }
    return g_running ? G_SOURCE_CONTINUE : G_SOURCE_REMOVE;
}

int main(int argc, char** argv) {
    gtk_init(&argc, &argv);
    if (argc > 2) g_control_port = std::atoi(argv[2]);
    const char* initial = (argc > 1 && argv[1] && *argv[1]) ? argv[1] : "about:blank";
    g_profile = std::getenv("SOLOHOST_BROWSER_DATA") ? std::getenv("SOLOHOST_BROWSER_DATA") : "/tmp/solohost-browser/profile";
    g_downloads = std::getenv("SOLOHOST_DOWNLOADS") ? std::getenv("SOLOHOST_DOWNLOADS") : (g_profile + "/downloads");
    fs::create_directories(g_profile);
    fs::create_directories(g_downloads);

    std::string cache = g_profile + "/cache";
    fs::create_directories(cache);
    g_data_manager = webkit_website_data_manager_new(
        "base-data-directory", g_profile.c_str(),
        "base-cache-directory", cache.c_str(),
        nullptr);
    g_context = webkit_web_context_new_with_website_data_manager(g_data_manager);
    g_object_unref(g_data_manager);
    webkit_web_context_set_cache_model(g_context, WEBKIT_CACHE_MODEL_WEB_BROWSER);
    webkit_web_context_set_web_process_count_limit(g_context, 4);
    // WebKitGTK provides a real web-process sandbox. Keep it on by default for untrusted web content.
    if (!std::getenv("SOLOHOST_WEBKIT_SANDBOX") || std::string(std::getenv("SOLOHOST_WEBKIT_SANDBOX")) != "0") {
        webkit_web_context_set_sandbox_enabled(g_context, TRUE);
    }
    g_signal_connect(g_context, "download-started", G_CALLBACK(on_download_started), nullptr);

    g_window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
    gtk_window_set_title(GTK_WINDOW(g_window), "SoloHost Browser");
    gtk_window_set_default_size(GTK_WINDOW(g_window), 1280, 720);
    gtk_window_set_decorated(GTK_WINDOW(g_window), FALSE);
    g_notebook = gtk_notebook_new();
    gtk_notebook_set_show_tabs(GTK_NOTEBOOK(g_notebook), FALSE);
    gtk_container_add(GTK_CONTAINER(g_window), g_notebook);
    gtk_widget_show_all(g_window);
    g_signal_connect(g_window, "destroy", G_CALLBACK(gtk_main_quit), nullptr);

    create_tab("home", initial);
    std::thread(control_server).detach();
    g_timeout_add_seconds(1, watchdog, nullptr);
    gtk_main();
    g_running = false;
    if (g_context) g_object_unref(g_context);
    return 0;
}
