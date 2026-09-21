using System.Diagnostics;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using SoloHost.Browser.Profile;
using SoloHost.Browser.Runtime;
using SoloHost.Browser.SoloHost;

namespace SoloHost.Browser;

public sealed class MainForm : Form
{
    readonly Panel chrome = new();
    readonly FlowLayoutPanel tabs = new();
    readonly Button btnBack = IconButton("←", "Back");
    readonly Button btnForward = IconButton("→", "Forward");
    readonly Button btnReload = IconButton("↻", "Reload");
    readonly Button btnHome = IconButton("⌂", "Home");
    readonly TextBox address = new();
    readonly Button btnMenu = IconButton("⋮", "Menu");
    readonly Button btnNew = IconButton("+", "New tab");
    readonly Button btnShield = IconButton("🛡", "Private");
    readonly Panel stage = new();
    readonly Panel setup = new();
    readonly Label setupTitle = new();
    readonly Label setupBody = new();
    readonly Button setupAction = new();
    readonly ContextMenuStrip menu = new();

    readonly List<BrowserTab> open = new();
    readonly Stack<string> closed = new();
    readonly AppSettings settings = JsonStore.Load(Paths.SettingsFile, new AppSettings());
    readonly List<HistoryItem> history;
    readonly List<BookmarkItem> bookmarks;
    readonly SoloHostClient solo = new();
    SoloHostStatus soloStatus = new();
    bool @private;
    BrowserTab? active;

    public MainForm()
    {
        history = settings.SaveHistory ? JsonStore.Load(Paths.HistoryFile, new List<HistoryItem>()) : new();
        bookmarks = JsonStore.Load(Paths.BookmarkFile, new List<BookmarkItem>());

        Text = "SoloHost Browser";
        Width = 1280;
        Height = 800;
        MinimumSize = new Size(800, 560);
        BackColor = Color.FromArgb(12, 13, 16);
        ForeColor = Color.FromArgb(236, 235, 230);
        Font = new Font("Segoe UI", 10f);
        StartPosition = FormStartPosition.CenterScreen;
        KeyPreview = true;

        chrome.Dock = DockStyle.Top;
        chrome.Height = 86;
        chrome.Padding = new Padding(10, 8, 10, 8);
        chrome.BackColor = Color.FromArgb(16, 17, 21);

        tabs.Dock = DockStyle.Top;
        tabs.Height = 34;
        tabs.WrapContents = false;
        tabs.AutoScroll = true;
        tabs.BackColor = Color.Transparent;

        var nav = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            WrapContents = false,
            Padding = new Padding(0, 4, 0, 0)
        };
        foreach (var b in new[] { btnBack, btnForward, btnReload, btnHome })
            nav.Controls.Add(b);

        address.BorderStyle = BorderStyle.None;
        address.Width = 520;
        address.Height = 28;
        address.BackColor = Color.FromArgb(22, 23, 28);
        address.ForeColor = Color.FromArgb(236, 235, 230);
        address.Margin = new Padding(12, 6, 12, 0);
        address.PlaceholderText = "Search or enter website";
        address.KeyDown += AddressKeyDown;

        nav.Controls.Add(address);
        nav.Controls.Add(btnShield);
        nav.Controls.Add(btnMenu);
        nav.Controls.Add(btnNew);

        chrome.Controls.Add(nav);
        chrome.Controls.Add(tabs);

        stage.Dock = DockStyle.Fill;
        stage.BackColor = Color.FromArgb(12, 13, 16);

        setup.Dock = DockStyle.Fill;
        setup.Visible = false;
        setup.BackColor = Color.FromArgb(12, 13, 16);
        setupTitle.AutoSize = false;
        setupTitle.Dock = DockStyle.Top;
        setupTitle.Height = 48;
        setupTitle.TextAlign = ContentAlignment.BottomCenter;
        setupTitle.Font = new Font("Segoe UI", 16f, FontStyle.Regular);
        setupBody.Dock = DockStyle.Top;
        setupBody.Height = 80;
        setupBody.TextAlign = ContentAlignment.TopCenter;
        setupBody.ForeColor = Color.FromArgb(160, 156, 148);
        setupAction.Text = "Install";
        setupAction.Width = 140;
        setupAction.Height = 36;
        setupAction.FlatStyle = FlatStyle.Flat;
        setupAction.Click += async (_, _) => await InstallRuntimeAsync();
        var setupWrap = new FlowLayoutPanel { Dock = DockStyle.Fill };
        setupWrap.Controls.Add(setupAction);
        setup.Controls.Add(setupWrap);
        setup.Controls.Add(setupBody);
        setup.Controls.Add(setupTitle);

        Controls.Add(stage);
        Controls.Add(setup);
        Controls.Add(chrome);

        btnBack.Click += (_, _) => active?.View.GoBack();
        btnForward.Click += (_, _) => active?.View.GoForward();
        btnReload.Click += (_, _) =>
        {
            if (active?.View.CoreWebView2 is null) return;
            if (active.Loading) active.View.Stop();
            else active.View.Reload();
        };
        btnHome.Click += (_, _) => Navigate(HomeUrl());
        btnNew.Click += (_, _) => NewTab(HomeUrl());
        btnShield.Click += (_, _) => TogglePrivate();
        btnMenu.Click += (_, _) => ShowMenu();

        BuildMenu();
        Load += async (_, _) => await StartAsync();
        FormClosing += (_, _) => Persist();
        Resize += (_, _) => address.Width = Math.Max(280, ClientSize.Width - 420);
    }

    static Button IconButton(string text, string tip)
    {
        var b = new Button
        {
            Text = text,
            Width = 36,
            Height = 32,
            FlatStyle = FlatStyle.Flat,
            BackColor = Color.Transparent,
            ForeColor = Color.FromArgb(200, 196, 188),
            TabStop = true,
            AccessibleName = tip
        };
        b.FlatAppearance.BorderSize = 0;
        b.FlatAppearance.MouseOverBackColor = Color.FromArgb(36, 37, 42);
        var hint = new ToolTip();
        hint.SetToolTip(b, tip);
        return b;
    }

    void BuildMenu()
    {
        menu.Items.Add("↓  Downloads", null, (_, _) =>
        {
            try { Process.Start(new ProcessStartInfo("explorer.exe", Paths.Downloads) { UseShellExecute = true }); }
            catch { }
        });
        menu.Items.Add("☆  Bookmark", null, (_, _) => BookmarkCurrent());
        menu.Items.Add("◷  History", null, (_, _) => ShowList("History", history.Select(h => (h.Title, h.Url))));
        menu.Items.Add("☰  Bookmarks", null, (_, _) => ShowList("Bookmarks", bookmarks.Select(b => (b.Title, b.Url))));
        menu.Items.Add("⊞  Apps", null, async (_, _) => await OpenAppsAsync());
        menu.Items.Add("🩺  Diagnostics", null, (_, _) => OpenDiagnostics());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("⌫  Clear data", null, (_, _) => ClearData());
        menu.Items.Add("＋  New tab", null, (_, _) => NewTab(HomeUrl()));
        menu.Items.Add("◻  Private tab", null, (_, _) => { if (!@private) TogglePrivate(); NewTab(HomeUrl()); });
    }

    void ShowMenu() => menu.Show(btnMenu, new Point(0, btnMenu.Height));

    async Task StartAsync()
    {
        if (!WebView2Detector.IsAvailable())
        {
            setup.Visible = true;
            stage.Visible = false;
            setupTitle.Text = "WebView2 Runtime";
            setupBody.Text = "Install the official Evergreen runtime, then open SoloHost Browser again.";
            return;
        }

        setup.Visible = false;
        stage.Visible = true;
        _ = RefreshSoloAsync();

        if (settings.RestoreSession)
        {
            var session = JsonStore.Load(Paths.SessionFile, new SessionState());
            if (session.Tabs.Count > 0)
            {
                foreach (var url in session.Tabs) NewTab(url, activate: false);
                ActivateTab(open[Math.Clamp(session.Active, 0, open.Count - 1)]);
                return;
            }
        }
        NewTab(HomeUrl());
    }

    async Task InstallRuntimeAsync()
    {
        try
        {
            Process.Start(new ProcessStartInfo(WebView2Detector.BootstrapperUrl) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "SoloHost Browser");
        }
        await Task.Delay(800);
    }

    string HomeUrl()
    {
        var start = Path.Combine(AppContext.BaseDirectory, "Resources", "start.html");
        if (File.Exists(start)) return new Uri(start).AbsoluteUri;
        return "https://duckduckgo.com/";
    }

    void NewTab(string url, bool activate = true)
    {
        var tab = new BrowserTab { Title = "…" };
        tab.Chip.Click += (_, _) => ActivateTab(tab);
        tab.Close.Click += (_, _) => CloseTab(tab);
        tabs.Controls.Add(tab.Chip);
        open.Add(tab);
        _ = AttachEngine(tab, url);
        if (activate) ActivateTab(tab);
        RenderTabs();
    }

    async Task AttachEngine(BrowserTab tab, string url)
    {
        var folder = @private ? Path.Combine(Paths.PrivateData, tab.Id) : Paths.UserData;
        Directory.CreateDirectory(folder);
        var env = await CoreWebView2Environment.CreateAsync(null, folder);
        await tab.View.EnsureCoreWebView2Async(env);
        var core = tab.View.CoreWebView2;
        core.Settings.AreDefaultContextMenusEnabled = true;
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.IsStatusBarEnabled = true;
        core.DocumentTitleChanged += (_, _) =>
        {
            tab.Title = string.IsNullOrWhiteSpace(core.DocumentTitle) ? Pretty(core.Source) : core.DocumentTitle;
            RenderTabs();
            if (tab == active) Text = tab.Title + " · SoloHost";
        };
        core.SourceChanged += (_, _) =>
        {
            tab.Url = core.Source;
            if (tab == active) address.Text = DisplayUrl(tab.Url);
        };
        core.NavigationStarting += (_, e) =>
        {
            tab.Loading = true;
            if (tab == active) btnReload.Text = "×";
        };
        core.NavigationCompleted += (_, e) =>
        {
            tab.Loading = false;
            if (tab == active) btnReload.Text = "↻";
            if (e.IsSuccess && settings.SaveHistory && !@private && tab.Url.StartsWith("http", StringComparison.OrdinalIgnoreCase))
            {
                history.Insert(0, new HistoryItem { Title = tab.Title, Url = tab.Url });
                if (history.Count > 400) history.RemoveRange(400, history.Count - 400);
            }
        };
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            NewTab(e.Uri);
        };
        core.DownloadStarting += (_, e) =>
        {
            e.ResultFilePath = UniquePath(Path.Combine(Paths.Downloads, Path.GetFileName(e.ResultFilePath)));
            e.Handled = false;
        };
        core.PermissionRequested += (_, e) =>
        {
            var name = e.PermissionKind.ToString();
            var ans = MessageBox.Show($"{name} — Allow?", "SoloHost Browser",
                MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            e.State = ans == DialogResult.Yes
                ? CoreWebView2PermissionState.Allow
                : CoreWebView2PermissionState.Deny;
        };
        tab.View.Parent = stage;
        tab.View.Dock = DockStyle.Fill;
        NavigateTab(tab, url);
    }

    void ActivateTab(BrowserTab tab)
    {
        active = tab;
        foreach (var t in open)
        {
            t.View.Visible = t == tab;
            t.Chip.ForeColor = t == tab ? Color.White : Color.FromArgb(150, 146, 140);
        }
        address.Text = DisplayUrl(tab.Url);
        Text = (string.IsNullOrWhiteSpace(tab.Title) ? "SoloHost" : tab.Title) + " · SoloHost";
        btnBack.Enabled = tab.View.CanGoBack;
        btnForward.Enabled = tab.View.CanGoForward;
        RenderTabs();
    }

    void CloseTab(BrowserTab tab)
    {
        if (!string.IsNullOrWhiteSpace(tab.Url)) closed.Push(tab.Url);
        var i = open.IndexOf(tab);
        open.Remove(tab);
        tabs.Controls.Remove(tab.Chip);
        stage.Controls.Remove(tab.View);
        tab.View.Dispose();
        if (open.Count == 0) NewTab(HomeUrl());
        else ActivateTab(open[Math.Max(0, i - 1)]);
    }

    void RenderTabs()
    {
        foreach (var t in open)
        {
            var mark = t.Loading ? "…" : "";
            var label = (t.Title.Length > 18 ? t.Title[..18] + "…" : t.Title);
            t.TitleLabel.Text = mark + label;
        }
    }

    void Navigate(string raw)
    {
        if (active is null) NewTab(Normalize(raw));
        else NavigateTab(active, Normalize(raw));
    }

    void NavigateTab(BrowserTab tab, string url)
    {
        tab.Url = url;
        if (tab.View.CoreWebView2 != null) tab.View.CoreWebView2.Navigate(url);
        else tab.Pending = url;
        address.Text = DisplayUrl(url);
    }

    string Normalize(string raw)
    {
        var s = (raw ?? "").Trim();
        if (s.Length == 0) return HomeUrl();
        if (s.StartsWith("solohost:", StringComparison.OrdinalIgnoreCase)) return HomeUrl();
        if (s.StartsWith("file:", StringComparison.OrdinalIgnoreCase)) return s;
        if (LooksLikeUrl(s))
        {
            if (!s.Contains("://")) s = "https://" + s;
            return s;
        }
        return settings.Search.Replace("{q}", Uri.EscapeDataString(s), StringComparison.Ordinal);
    }

    static bool LooksLikeUrl(string s)
    {
        if (s.Contains(' ')) return false;
        if (s.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
            s.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) return true;
        return s.Contains('.') && !s.StartsWith(".");
    }

    static string DisplayUrl(string url)
    {
        if (url.StartsWith("file:", StringComparison.OrdinalIgnoreCase)) return "";
        return url;
    }

    static string Pretty(string url)
    {
        try { return new Uri(url).Host.Replace("www.", ""); }
        catch { return url; }
    }

    void AddressKeyDown(object? sender, KeyEventArgs e)
    {
        if (e.KeyCode == Keys.Enter)
        {
            e.SuppressKeyPress = true;
            Navigate(address.Text);
        }
    }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        if (e.Control && e.KeyCode == Keys.T) { NewTab(HomeUrl()); e.Handled = true; }
        if (e.Control && e.KeyCode == Keys.W && active != null) { CloseTab(active); e.Handled = true; }
        if (e.Control && e.KeyCode == Keys.L) { address.Focus(); address.SelectAll(); e.Handled = true; }
        if (e.Control && e.Shift && e.KeyCode == Keys.T && closed.Count > 0) { NewTab(closed.Pop()); e.Handled = true; }
        if (e.Control && e.KeyCode == Keys.R) { active?.View.Reload(); e.Handled = true; }
        if (e.Control && e.KeyCode == Keys.D) { BookmarkCurrent(); e.Handled = true; }
        if (e.Control && e.KeyCode == Keys.P) { active?.View.CoreWebView2?.ShowPrintUI(); e.Handled = true; }
        if (e.Control && e.KeyCode == Keys.F) { active?.View.CoreWebView2?.ExecuteScriptAsync("window.find('')"); e.Handled = true; }
        if (e.KeyCode == Keys.F5) { active?.View.Reload(); e.Handled = true; }
        if (e.KeyCode == Keys.F11) WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
        base.OnKeyDown(e);
    }

    void BookmarkCurrent()
    {
        if (active is null || string.IsNullOrWhiteSpace(active.Url)) return;
        if (!active.Url.StartsWith("http", StringComparison.OrdinalIgnoreCase)) return;
        bookmarks.RemoveAll(b => b.Url == active.Url);
        bookmarks.Insert(0, new BookmarkItem { Title = active.Title, Url = active.Url });
        JsonStore.Save(Paths.BookmarkFile, bookmarks);
    }

    void ShowList(string title, IEnumerable<(string Title, string Url)> items)
    {
        var pick = items.FirstOrDefault();
        using var dlg = new Form
        {
            Text = title,
            Width = 420,
            Height = 480,
            BackColor = Color.FromArgb(16, 17, 21),
            ForeColor = Color.White,
            StartPosition = FormStartPosition.CenterParent
        };
        var list = new ListBox { Dock = DockStyle.Fill, BackColor = Color.FromArgb(16, 17, 21), ForeColor = Color.White };
        var data = items.Take(80).ToList();
        foreach (var it in data) list.Items.Add(it.Title + "  —  " + it.Url);
        list.DoubleClick += (_, _) =>
        {
            if (list.SelectedIndex >= 0) { Navigate(data[list.SelectedIndex].Url); dlg.Close(); }
        };
        dlg.Controls.Add(list);
        dlg.ShowDialog(this);
    }

    async Task OpenAppsAsync()
    {
        soloStatus = await solo.ProbeAsync();
        if (soloStatus.State != "online")
        {
            MessageBox.Show("SoloHost apps unavailable", "SoloHost Browser",
                MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        ShowList("Apps", soloStatus.Apps.Select(a => (a.Name, ResolveAppUrl(a.Route))));
    }

    static string ResolveAppUrl(string route)
    {
        if (string.IsNullOrWhiteSpace(route)) return "http://127.0.0.1:8080/";
        if (route.StartsWith("http", StringComparison.OrdinalIgnoreCase)) return route;
        return "http://127.0.0.1:8080" + (route.StartsWith('/') ? route : "/" + route);
    }

    void OpenDiagnostics()
    {
        var page = Path.Combine(AppContext.BaseDirectory, "Resources", "diagnostics.html");
        if (File.Exists(page)) NewTab(new Uri(page).AbsoluteUri);
        else NewTab("https://cloudflare.com/cdn-cgi/trace");
    }

    void ClearData()
    {
        if (MessageBox.Show("Clear browsing data?", "SoloHost Browser", MessageBoxButtons.YesNo) != DialogResult.Yes)
            return;
        history.Clear();
        JsonStore.Save(Paths.HistoryFile, history);
    }

    void TogglePrivate()
    {
        @private = !@private;
        btnShield.ForeColor = @private ? Color.FromArgb(180, 220, 190) : Color.FromArgb(200, 196, 188);
        if (@private)
        {
            try { Directory.Delete(Paths.PrivateData, true); } catch { }
            Directory.CreateDirectory(Paths.PrivateData);
        }
    }

    async Task RefreshSoloAsync()
    {
        try { soloStatus = await solo.ProbeAsync(); }
        catch { soloStatus = new SoloHostStatus { State = "not-detected" }; }
    }

    static string UniquePath(string path)
    {
        if (!File.Exists(path)) return path;
        var dir = Path.GetDirectoryName(path)!;
        var name = Path.GetFileNameWithoutExtension(path);
        var ext = Path.GetExtension(path);
        for (var i = 2; i < 1000; i++)
        {
            var next = Path.Combine(dir, $"{name} ({i}){ext}");
            if (!File.Exists(next)) return next;
        }
        return path;
    }

    void Persist()
    {
        if (!@private && settings.SaveHistory) JsonStore.Save(Paths.HistoryFile, history);
        JsonStore.Save(Paths.BookmarkFile, bookmarks);
        JsonStore.Save(Paths.SettingsFile, settings);
        if (!@private && settings.RestoreSession)
        {
            JsonStore.Save(Paths.SessionFile, new SessionState
            {
                Tabs = open.Select(t => t.Url).Where(u => !string.IsNullOrWhiteSpace(u)).ToList(),
                Active = Math.Max(0, open.IndexOf(active!))
            });
        }
        if (@private)
        {
            try { Directory.Delete(Paths.PrivateData, true); } catch { }
        }
    }
}

sealed class BrowserTab
{
    public string Id { get; } = Guid.NewGuid().ToString("n");
    public string Title { get; set; } = "New tab";
    public string Url { get; set; } = "";
    public string? Pending { get; set; }
    public bool Loading { get; set; }
    public WebView2 View { get; } = new() { Visible = false };
    public Panel Chip { get; }
    public Label TitleLabel { get; }
    public Button Close { get; }

    public BrowserTab()
    {
        Chip = new Panel { Width = 168, Height = 28, Margin = new Padding(4, 2, 0, 0) };
        TitleLabel = new Label
        {
            Text = Title,
            AutoEllipsis = true,
            Width = 136,
            Height = 28,
            TextAlign = ContentAlignment.MiddleLeft,
            ForeColor = Color.FromArgb(200, 196, 188)
        };
        Close = new Button
        {
            Text = "×",
            Width = 24,
            Height = 24,
            FlatStyle = FlatStyle.Flat,
            Left = 140,
            Top = 2,
            BackColor = Color.Transparent,
            ForeColor = Color.FromArgb(160, 156, 148),
            AccessibleName = "Close tab"
        };
        Close.FlatAppearance.BorderSize = 0;
        Chip.Controls.Add(TitleLabel);
        Chip.Controls.Add(Close);
    }
}
