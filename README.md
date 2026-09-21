# SoloHost Browser

A lightweight standalone browser that can optionally connect to SoloHost.

Internet browsing does **not** require Docker, SoloHost, Pi Node, Node.js,
Python, Git, or Visual Studio.

## Two layers

```
SoloHost Browser.exe   (native Windows app)
        │
        └── WebView2 / Chromium  →  Internet

Optional:
        └── HTTP probe to a local SoloHost hub → Apps
```

These paths are independent. If SoloHost or Docker is missing, the browser
still opens websites.

## Native Windows app

Source: `native/windows/SoloHostBrowser`

On a Windows machine with the .NET 8 SDK:

```powershell
powershell -File installer\windows\build.ps1
powershell -File installer\windows\install.ps1
```

The published `SoloHostBrowser.exe` is self-contained. End users do not need
the SDK. They do need a supported Windows 10/11 and the Evergreen WebView2
Runtime (the app detects it and opens the official Microsoft installer if it
is missing).

Profile data lives in `%LOCALAPPDATA%\SoloHost\Browser`.

## Optional SoloHost hub

The Node files in this repository remain an optional local app catalog.
They are not used to render Google, Facebook, or other public sites.

```bash
node server.js
```

## Tests

```bash
node tests/browser/architecture.test.js
node test.js
```

Windows build and WebView2 launch are not executed in the Linux packager.

## Product

Simple. Private. Lightweight. Secure.
