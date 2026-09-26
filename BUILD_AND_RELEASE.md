# Build and release

## Local image build

The production image is a multi-stage build. The build stage downloads the pinned CEF 152 Linux x64 binary distribution, compiles the native CEF browser core and packages the CEF runtime files.

```bash
docker build -t ghcr.io/cannoi/solohost-browser:5.0.0 .
```

## Smoke test

```bash
docker run --rm -p 18080:8080 --shm-size=1g ghcr.io/cannoi/solohost-browser:5.0.0
```

Open the mapped SoloHost Browser URL and verify:

1. Chromium page renders without VNC/noVNC.
2. Address bar navigation works.
3. Links and forms accept mouse/keyboard input.
4. Back/forward/reload work.
5. New tabs remain independent.
6. Cookies/local storage survive a container restart using the named data volume.
7. `/health` reports `engine: CEF/Chromium` and `display: off-screen-rendering`.

## SoloHost deployment

`docker-compose.yml` intentionally uses the immutable image reference rather than `build:`. Publish the verified image to the configured registry before installing the ZIP on a SoloHost instance.
