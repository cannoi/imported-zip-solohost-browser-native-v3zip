using Microsoft.Web.WebView2.Core;

namespace SoloHost.Browser.Runtime;

public static class WebView2Detector
{
    public static bool IsWindowsSupported()
    {
        var os = Environment.OSVersion;
        if (os.Platform != PlatformID.Win32NT) return false;
        // Windows 10 1809+ / Windows 11
        return os.Version.Major > 10 || (os.Version.Major == 10 && os.Version.Build >= 17763);
    }

    public static string? InstalledVersion()
    {
        try
        {
            return CoreWebView2Environment.GetAvailableBrowserVersionString();
        }
        catch
        {
            return null;
        }
    }

    public static bool IsAvailable() => !string.IsNullOrWhiteSpace(InstalledVersion());

    public static string BootstrapperUrl =>
        "https://go.microsoft.com/fwlink/p/?LinkId=2124703";
}
