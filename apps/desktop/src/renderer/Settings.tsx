import { useState } from 'react';
import { FolderOpen, X } from 'lucide-react';
import type { Settings as SettingsType, SettingsUpdate } from '../shared/types';

export function SettingsDialog({
  settings,
  onClose,
  onSave,
}: {
  settings: SettingsType;
  onClose: () => void;
  onSave: (settings: SettingsUpdate) => Promise<void>;
}) {
  const [values, setValues] = useState<SettingsUpdate>({
    provider: settings.provider,
    model: settings.model,
    ollamaUrl: settings.ollamaUrl,
    corpusPath: settings.corpusPath,
    pistonUrl: settings.pistonUrl,
    connection: settings.connection,
    mcpUrl: settings.mcpUrl,
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const field = (key: keyof SettingsUpdate, value: unknown) =>
    setValues((current) => ({ ...current, [key]: value }));
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await onSave(values);
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not save settings');
    } finally {
      setSaving(false);
    }
  }
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <section
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <header>
          <div>
            <span className="eyebrow">YOUR WORKSPACE, YOUR MODELS</span>
            <h2 id="settings-title">Workbench settings</h2>
          </div>
          <button
            className="icon-button"
            aria-label="Close settings"
            onClick={onClose}
            disabled={saving}
          >
            <X size={19} />
          </button>
        </header>
        <form onSubmit={submit}>
          <fieldset>
            <legend>AI coach</legend>
            <label>
              Provider
              <select
                value={values.provider}
                onChange={(event) => {
                  const provider = event.target.value as SettingsUpdate['provider'];
                  field('provider', provider);
                  field(
                    'model',
                    provider === 'anthropic' ? 'claude-haiku-4-5-20251001' : 'qwen3:4b',
                  );
                }}
              >
                <option value="disabled">Off — practice with curated hints</option>
                <option value="ollama">Ollama — local model, no API fees</option>
                <option value="anthropic">Claude — bring your own API key</option>
              </select>
            </label>
            {values.provider !== 'disabled' && (
              <label>
                Model
                <input
                  value={values.model}
                  onChange={(event) => field('model', event.target.value)}
                  required
                  maxLength={120}
                />
              </label>
            )}
            {values.provider === 'ollama' && (
              <>
                <label>
                  Ollama URL
                  <input
                    value={values.ollamaUrl}
                    onChange={(event) => field('ollamaUrl', event.target.value)}
                    required
                  />
                </label>
                <p className="form-note">
                  Ollama must already be running on your computer with a tool-capable model
                  installed. No model is downloaded automatically.
                </p>
              </>
            )}
            {values.provider === 'anthropic' && (
              <>
                <label>
                  Claude API key
                  <input
                    type="password"
                    autoComplete="off"
                    placeholder={
                      settings.hasApiKey
                        ? 'Key saved — leave blank to keep it'
                        : 'Paste your own API key'
                    }
                    onChange={(event) => field('apiKey', event.target.value)}
                  />
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    onChange={(event) => field('clearApiKey', event.target.checked)}
                  />
                  Remove saved API key
                </label>
                <p className="form-note warning">
                  Each chat turn sends your selected draft and problem context to Anthropic and
                  incurs usage charges. Requests only happen when you send a message. The coach uses
                  a bounded tool loop.
                </p>
              </>
            )}
            {!settings.secureStorage && (
              <p className="form-note warning">
                An OS credential store is unavailable. Keys stay in memory for this session and will
                not be written to disk.
              </p>
            )}
          </fieldset>
          <fieldset>
            <legend>Interview MCP</legend>
            <label>
              Connection
              <select
                value={values.connection}
                onChange={(event) => field('connection', event.target.value)}
              >
                <option value="local">Local engine — no hosting bill</option>
                <option value="remote">Existing remote MCP</option>
              </select>
            </label>
            {values.connection === 'local' ? (
              <>
                <label>
                  Private runtime question folder
                  <div className="input-action">
                    <input
                      value={values.corpusPath}
                      placeholder="Bundled public examples"
                      onChange={(event) => field('corpusPath', event.target.value)}
                    />
                    <button
                      type="button"
                      className="secondary"
                      onClick={async () => {
                        const path = await window.interview.chooseCorpus();
                        if (path) field('corpusPath', path);
                      }}
                    >
                      <FolderOpen size={16} /> Browse
                    </button>
                  </div>
                </label>
                <p className="form-note">
                  Choose an exported runtime folder, not the authoring repo. Your private questions
                  never enter the app distribution.
                </p>
                <label>
                  Piston sandbox URL
                  <input
                    value={values.pistonUrl}
                    onChange={(event) => field('pistonUrl', event.target.value)}
                    required
                  />
                </label>
                <p className="form-note">
                  Code execution requires the local Docker sandbox and Python 3.12 runtime. Editor,
                  descriptions, and curated hints work without it.
                </p>
              </>
            ) : (
              <>
                <label>
                  HTTPS MCP URL
                  <input
                    value={values.mcpUrl}
                    placeholder="https://your-server/mcp"
                    onChange={(event) => field('mcpUrl', event.target.value)}
                    required
                  />
                </label>
                <label>
                  Personal MCP bearer key
                  <input
                    type="password"
                    autoComplete="off"
                    placeholder={
                      settings.hasMcpKey ? 'Key saved — leave blank to keep it' : 'imcp_…'
                    }
                    onChange={(event) => field('mcpKey', event.target.value)}
                  />
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    onChange={(event) => field('clearMcpKey', event.target.checked)}
                  />
                  Remove saved MCP key
                </label>
                <p className="form-note">
                  Each server/key combination gets its own local workspace to prevent account
                  mixing.
                </p>
              </>
            )}
          </fieldset>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <footer>
            <span>Files and progress stay on your machine.</span>
            <button className="primary" disabled={saving}>
              {saving ? 'Connecting…' : 'Save & connect'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
