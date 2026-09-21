# Windows install

Build machine (developer):

1. Install .NET 8 SDK from https://dot.net
2. `powershell -File installer\windows\build.ps1`
3. `powershell -File installer\windows\install.ps1`

End-user machine:

1. Copy `dist\windows\SoloHostBrowser.exe` (after a Windows publish)
2. Run it
3. If WebView2 Runtime is missing, the app opens Microsoft's official installer

No Docker, SoloHost, Node, or Visual Studio is required to browse.
