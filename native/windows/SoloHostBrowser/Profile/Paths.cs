namespace SoloHost.Browser.Profile;

public static class Paths
{
    public static string Root
    {
        get
        {
            var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            return Path.Combine(local, "SoloHost", "Browser");
        }
    }

    public static string UserData => Path.Combine(Root, "User Data");
    public static string PrivateData => Path.Combine(Root, "Private Data");
    public static string Downloads => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
    public static string HistoryFile => Path.Combine(Root, "history.json");
    public static string BookmarkFile => Path.Combine(Root, "bookmarks.json");
    public static string SettingsFile => Path.Combine(Root, "settings.json");
    public static string SessionFile => Path.Combine(Root, "session.json");

    public static void Ensure()
    {
        Directory.CreateDirectory(Root);
        Directory.CreateDirectory(UserData);
        Directory.CreateDirectory(PrivateData);
    }
}
