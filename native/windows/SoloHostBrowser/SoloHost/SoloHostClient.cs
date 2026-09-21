using System.Net.Http;
using System.Text.Json;

namespace SoloHost.Browser.SoloHost;

public sealed class SoloHostStatus
{
    public string State { get; set; } = "not-detected"; // not-detected | online | offline
    public List<SoloHostApp> Apps { get; set; } = new();
}

public sealed class SoloHostApp
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Icon { get; set; } = "app";
    public string Route { get; set; } = "";
    public string Status { get; set; } = "";
}

public sealed class SoloHostClient
{
    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMilliseconds(1200) };

    public static IEnumerable<Uri> Candidates()
    {
        var extra = Environment.GetEnvironmentVariable("SOLOHOST_APP_MANAGER_URL");
        if (!string.IsNullOrWhiteSpace(extra) && Uri.TryCreate(extra, UriKind.Absolute, out var u))
            yield return u;
        yield return new Uri("http://127.0.0.1:8080/");
        yield return new Uri("http://127.0.0.1:18080/");
        yield return new Uri("http://localhost:8080/");
    }

    public async Task<SoloHostStatus> ProbeAsync()
    {
        foreach (var baseUri in Candidates())
        {
            try
            {
                using var health = await Http.GetAsync(new Uri(baseUri, "health"));
                if (!health.IsSuccessStatusCode) continue;
                var status = new SoloHostStatus { State = "online" };
                try
                {
                    using var apps = await Http.GetAsync(new Uri(baseUri, "api/apps"));
                    if (apps.IsSuccessStatusCode)
                    {
                        using var doc = JsonDocument.Parse(await apps.Content.ReadAsStringAsync());
                        if (doc.RootElement.TryGetProperty("apps", out var list) && list.ValueKind == JsonValueKind.Array)
                        {
                            foreach (var a in list.EnumerateArray())
                            {
                                status.Apps.Add(new SoloHostApp
                                {
                                    Id = a.TryGetProperty("id", out var id) ? id.GetString() ?? "" : "",
                                    Name = a.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "",
                                    Icon = a.TryGetProperty("icon", out var ic) ? ic.GetString() ?? "app" : "app",
                                    Route = a.TryGetProperty("route", out var r) ? r.GetString() ?? "" : "",
                                    Status = a.TryGetProperty("status", out var s) ? s.GetString() ?? "" : ""
                                });
                            }
                        }
                    }
                }
                catch { /* apps optional */ }
                return status;
            }
            catch
            {
                // try next candidate
            }
        }
        return new SoloHostStatus { State = "not-detected" };
    }
}
