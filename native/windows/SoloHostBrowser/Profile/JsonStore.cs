using System.Text.Json;

namespace SoloHost.Browser.Profile;

public static class JsonStore
{
    static readonly JsonSerializerOptions Opts = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    public static T Load<T>(string path, T fallback) where T : class
    {
        try
        {
            if (!File.Exists(path)) return fallback;
            return JsonSerializer.Deserialize<T>(File.ReadAllText(path), Opts) ?? fallback;
        }
        catch
        {
            return fallback;
        }
    }

    public static void Save<T>(string path, T value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(value, Opts));
        File.Copy(tmp, path, true);
        File.Delete(tmp);
    }
}

public sealed class HistoryItem
{
    public string Title { get; set; } = "";
    public string Url { get; set; } = "";
    public DateTime At { get; set; } = DateTime.UtcNow;
}

public sealed class BookmarkItem
{
    public string Id { get; set; } = Guid.NewGuid().ToString("n");
    public string Title { get; set; } = "";
    public string Url { get; set; } = "";
}

public sealed class AppSettings
{
    public string Search { get; set; } = "https://duckduckgo.com/?q={q}";
    public bool RestoreSession { get; set; } = true;
    public bool SaveHistory { get; set; } = true;
}

public sealed class SessionState
{
    public List<string> Tabs { get; set; } = new();
    public int Active { get; set; }
}
