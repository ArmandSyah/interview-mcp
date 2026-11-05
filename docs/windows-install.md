# Install Interview Workbench on Windows

The preview is for Windows x64.
The package contains the app, Python engine, and sample questions.
Node.js, uv, and a Python installation are not necessary to start the app.
Docker is necessary only for code execution.
AI is off at first startup.

## Download a preview

A GitHub account with repository read access is necessary to download workflow artifacts.
See the [GitHub artifact guide](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts?tool=webui).
This workflow keeps download artifacts for 30 days.

1. Open the [Windows installer preview workflow](https://github.com/ArmandSyah/interview-mcp/actions/workflows/windows-installer.yml).
2. Select a run with a `success` result for the source revision to install.
3. Download `interview-workbench-windows-preview` from **Artifacts**.
4. Extract the ZIP file into a new directory.
5. Open `build-info.json`.
6. Make sure that `sourceCommit` agrees with the source commit in the selected workflow run.

Before installation, make sure that the **Desktop** workflow result is `success` for the same source commit.

The download contains one installer, `SHA256SUMS.txt`, `build-info.json`, and these instructions.
The build record identifies the version, source commit, architecture, installer byte count, and checksum.

## Examine the download

Before installation, open PowerShell in the extracted directory.
Enter these commands:

```powershell
$previewInstaller = @(Get-ChildItem -File -Filter '*.exe')
if ($previewInstaller.Count -ne 1) { throw 'Expected one installer' }
(Get-FileHash -LiteralPath $previewInstaller[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant()
Get-Content -LiteralPath .\SHA256SUMS.txt
```

Compare the hash values.
If the values are not the same:

1. Download the artifact again.
2. Extract that artifact into a new directory.

The checksum helps you find a changed download.
It does not identify the publisher.

The development installer has no publisher signature.
Windows can show **Unknown publisher**.
Examine the source commit and workflow result before installation.

## Install and start

1. When the hashes agree, run the installer.
2. Select installation for your Windows account.
3. Select a destination directory.
4. Complete installation.
5. Open **Interview Workbench** from the Start menu.

You can use coding drafts, hints, and the design whiteboard without a model.
The [desktop guide](../apps/desktop/README.md) gives instructions for optional Docker and AI setup.
Installation does not download a model or start Docker.

## Remove or reinstall

Before removal, close **Interview Workbench**.
Use **Installed apps** or **Apps & features** in Windows Settings.
Select **Interview Workbench**.
Then select **Uninstall**.

The installer keeps practice files after removal.
Reinstallation can use those saved files again.
Use **Export practice backup** before you change app versions.
Use an app version that can read the saved database format.

The backup export is an archive. The app has no archive restore UI.
The [local storage guide](../apps/desktop/README.md#local-storage-and-backups) describes the saved files and backups.

## Build and verification

The preview workflow builds the Windows installer and tests it on a temporary GitHub runner.
The test installs the app into a directory with spaces in its name.
It saves code and design work, removes the app, and compares the saved files.
It also examines default application-data markers after removal.
Then it reinstalls the app and opens the saved work.

The **Desktop** workflow supplies the UI test results.
The installer lifecycle test does not run code in Piston.
See [implementation status](../IMPLEMENTATION_STATUS.json) for recorded results and open audit work.

For a local package build, use Windows.
Install Git, Node.js 24, and uv as described in the desktop guide.
Enter these commands from the repository root:

```powershell
uv sync --frozen --dev --python 3.12
cd apps/desktop
npm ci
npm run install:electron
npm run backend
npm run build
npx electron-builder --win nsis --x64 --publish never
node scripts/windows-artifacts.mjs
```

The files are in `apps/desktop/release`.
Use the GitHub workflow for the installer lifecycle test.
The test stops unless `RUNNER_ENVIRONMENT` is `github-hosted`.

The metadata script uses `GITHUB_SHA` and `GITHUB_RUN_ID` for build identity.
When a variable has no value, the script records `null`.
