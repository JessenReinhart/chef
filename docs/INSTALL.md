# Install and Launch Chef

Chef is local-first. The browser is the interface, but your project files, terminals, agents, Git operations, and Chef database stay on your computer.

## Fastest path on Windows

### 1. Install Node.js 24 or later

Chef currently needs Node.js 24+ with npm.

Check your installation:

```powershell
node --version
npm --version
```

### 2. Get Chef

Clone the repository:

```powershell
git clone https://github.com/JessenReinhart/chef.git
cd chef
```

You can also download the repository as a ZIP and extract it.

### 3. Start Chef

Choose either method.

**Double-click:**

Open the Chef folder and double-click `Chef.cmd`.

On the first Windows launch, Chef also prepares `Chef.lnk` beside `Chef.cmd`. The shortcut uses the Chef app icon and can be your normal launcher after that.

**Terminal:**

```powershell
npm run chef
```

That is the normal launch command. You do not need to start the runtime and web UI separately.

On the first launch, Chef automatically:

1. checks that Node.js 24+ is available;
2. installs missing runtime dependencies;
3. installs missing web dependencies;
4. builds the web interface when it is missing or out of date;
5. starts the local Chef runtime on `127.0.0.1:4321`;
6. opens Chef in your default browser;
7. on Windows, materializes the branded app icon and launcher shortcut.

Later launches reuse the installed dependencies and only rebuild the UI when needed.

## Open Chef manually

If the browser does not open automatically, go to:

```text
http://127.0.0.1:4321
```

If Chef is already running, launching it again will detect the existing runtime and open that instance instead of starting a duplicate server.

## Open a project

Use the project control in Chef to select your working directory.

On Windows, Chef can use the native folder picker. The selected directory becomes the active local project for terminals, agents, filesystem tools, Git, and project-scoped persistence.

Chef stores project state in:

```text
<project>/.chef/chef.sqlite
```

Recent project paths are stored in:

```text
~/.chef/recent-projects.json
```

## Add AI agents

Chef can host terminal-based tools such as Claude Code, Codex, OMP, Pi, Freebuff, and the generic terminal harness.

Install and authenticate the CLI you want to use normally on your machine. Chef does not need to copy that CLI's credentials into the project.

To check what Chef can detect:

```powershell
npm run doctor
```

The web UI also exposes harness readiness information.

## Configure the Chef Orchestrator

The Orchestrator can use a provider configured from the Chef UI. This is separate from credentials used by terminal-based agents.

If no direct provider is configured, Chef can still run with its deterministic scripted decision provider for development and testing.

## Stop Chef

If you launched Chef from a terminal, press `Ctrl+C` in that terminal.

If a project switch caused Chef to relaunch its runtime, the new process can continue independently. A dedicated tray/background-process manager is planned as part of the future packaged installation experience.

## Troubleshooting

### Chef says Node.js is too old

Install Node.js 24 or later and launch Chef again.

### The first launch takes longer

The first launch may need to install dependencies and build the web interface. Later launches reuse those files.

### Port 4321 is already in use

Chef first checks whether another Chef runtime is already listening there. If it is Chef, the launcher opens it. If another application owns the port, set another port before launch:

```powershell
$env:CHEF_PORT=4330
npm run chef
```

### The browser did not open

Open the runtime URL manually. For the default port:

```text
http://127.0.0.1:4321
```

### The branded shortcut did not appear

Chef still works through `Chef.cmd`. You can recreate the shortcut manually from the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ensure-windows-launcher.ps1
```

The generated `.ico` stays in your local app data and `Chef.lnk` is generated beside `Chef.cmd`.

### Diagnose the environment

Run:

```powershell
npm run doctor
```

## Developer mode

The friendly launcher is intended for normal use. UI development can still use separate processes:

Terminal 1:

```bash
npm run server
```

Terminal 2:

```bash
cd web
npm install
npm run dev
```

Vite runs the development UI and proxies `/api` requests to the local Chef runtime.

## Future packaged installation

The next distribution milestone is a real end-user package so users do not need Git, npm, or a repository checkout.

Target experience:

```text
Install Chef
→ Start Menu / desktop shortcut
→ Chef opens in the browser
→ local runtime starts automatically
```

The packaged installer should reuse `assets/chef-icon.svg` as its branding source so the browser, README, launcher, and installer stay visually consistent.

Possible distribution surfaces include a Windows installer and Winget package. The local runtime and browser-based UI architecture do not need to change for that milestone.
