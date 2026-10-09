# SoloHost Browser — Install

## Package layout (required by SoloHost)

The ZIP **root** must contain:

- `docker-compose.yml`
- `Dockerfile`
- `server.js`
- `package.json`
- `public/`
- `lib/`

Do **not** nest everything under an extra `solohost-browser/` folder when importing into Pi SoloHost.

If SoloHost logs:

```
compose file "...\pi-apps\cannoi-solohost-browser\docker-compose.yml" is invalid:
The system cannot find the path specified
```

that means the Windows app folder is missing `docker-compose.yml`.
Fix: re-import this ZIP (root-level files). The message is from the **Pi Network client**, not from Node inside the container.

When the log also shows `Container running` / `Image ... Pulled`, the browser service is already up — open the app UI and use it.

## Run (Docker)

```bash
docker compose up --build -d
```

App: http://127.0.0.1:8080
