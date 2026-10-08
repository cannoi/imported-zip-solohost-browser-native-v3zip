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

static gboolean on_permission_request(WebKitWebView*, WebKitPermissionRequest* request, gpointer) {
    // Secure default: permissions stay denied until a dedicated SoloHost permission UI exists.
    webkit_permission_request_deny(request);
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
    if (type == WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION) {
        webkit_policy_decision_use(decision);
        return TRUE;
    }
    return FALSE;
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
    std::string uri = "file://" + dest.string();
    webkit_download_set_destination(download, uri.c_str());
}

static void on_download_started(WebKitWebContext*, WebKitDownload* download, gpointer) {
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
        "enable-media-stream", std::getenv("SOLOHOST_ALLOW_MEDIA_STREAM") && std::string(std::getenv("SOLOHOST_ALLOW_MEDIA_STREAM")) == "1",
        "user-agent", "SoloHostBrowser/7.1 WebKit",
        nullptr);
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
