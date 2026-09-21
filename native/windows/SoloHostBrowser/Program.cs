using SoloHost.Browser.Profile;
using SoloHost.Browser.Runtime;

namespace SoloHost.Browser;

static class Program
{
    [STAThread]
    static void Main()
    {
        ApplicationConfiguration.Initialize();
        Paths.Ensure();

        if (!WebView2Detector.IsWindowsSupported())
        {
            MessageBox.Show("Windows version not supported.", "SoloHost Browser",
                MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        Application.Run(new MainForm());
    }
}
