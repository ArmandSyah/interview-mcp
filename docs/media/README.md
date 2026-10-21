# Demo capture

The README assets show the Electron app and the Python MCP engine.
The capture script uses a new temporary workspace. It does not read personal practice history or API keys.
The sample code is a draft, not a solution.

The agent demo uses a scripted HTTP model on `127.0.0.1`.
It uses the Ollama message format. It does not do model inference.
The model requests `get_hint`. The app supplies the saved attempt and calls the project's MCP tool.
The model then returns sample coach text.

The system-design demo uses AI off. Its checkpoints and design reviews use the project's backend.
The capture script rejects renderer errors and unexpected HTTP requests.
It also compares the draft before and after the model response.
See [capture-manifest.json](capture-manifest.json) for the capture results.

## Capture the assets again

Install the [desktop dependencies](../../apps/desktop/README.md#run-from-source).
Install FFmpeg. Make sure that its executable is on `PATH`.
As an alternative, set `FFMPEG_PATH` to the absolute executable path.

Enter these commands from `apps/desktop`:

```bash
npm run build
npm run demo -- --force
```

The `--force` option replaces only the six named demo assets in this directory.
Without that option, the script refuses to replace existing assets.
The script keeps temporary frames and its temporary workspace outside the checkout.
It does not make paid model calls. Docker is not necessary for demo capture.

The script captures PNG frames from UI actions. FFmpeg encodes those frames as looping GIFs.
The PNG screenshots use a 1440 by 900 pixel window.
The GIFs use a 1280 by 800 pixel window at six frames each second.

Each demo has a playback time of approximately 30 to 40 seconds. Pauses give you time to examine each result.
The recordings show step captions and a pointer. The screenshots show the app without these additions.

The capture script updates public assets only after all capture checks pass.
Examine each image before you publish it.
