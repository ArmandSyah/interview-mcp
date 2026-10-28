import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/languages/definitions/python/register.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
monaco.editor.defineTheme('interview-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6C7A8B', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'C7A1F7' },
    { token: 'string', foreground: 'ACD6A0' },
    { token: 'number', foreground: 'E6C48B' },
  ],
  colors: {
    'editor.background': '#171a21',
    'editor.foreground': '#d7dce5',
    'editorLineNumber.foreground': '#4c5668',
    'editorLineNumber.activeForeground': '#a4afc2',
    'editor.selectionBackground': '#334968',
    'editor.lineHighlightBackground': '#1e232d',
    'editorCursor.foreground': '#bca5ef',
    'editorIndentGuide.background1': '#282f3b',
  },
});

export function CodeEditor({
  id,
  code,
  onChange,
  onRun,
  onSave,
}: {
  id: string;
  code: string;
  onChange: (code: string) => void;
  onRun: () => void;
  onSave: () => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const callbacks = useRef({ onChange, onRun, onSave });
  callbacks.current = { onChange, onRun, onSave };
  useEffect(() => {
    if (!element.current) return;
    const instance = monaco.editor.create(element.current, {
      value: '',
      language: 'python',
      theme: 'interview-dark',
      automaticLayout: true,
      fontFamily: "'Cascadia Code', 'JetBrains Mono', 'SFMono-Regular', Consolas, monospace",
      fontSize: 14,
      lineHeight: 24,
      minimap: { enabled: false },
      padding: { top: 20, bottom: 16 },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      tabSize: 4,
      insertSpaces: true,
      renderWhitespace: 'selection',
      bracketPairColorization: { enabled: true },
      wordWrap: 'off',
      accessibilitySupport: 'on',
      // Use Monaco's established textarea input path across Electron versions.
      editContext: false,
      ariaLabel: 'Python solution editor',
    });
    editor.current = instance;
    const listener = instance.onDidChangeModelContent(() =>
      callbacks.current.onChange(instance.getValue()),
    );
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () =>
      callbacks.current.onRun(),
    );
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
      callbacks.current.onSave(),
    );
    return () => {
      listener.dispose();
      instance.dispose();
      editor.current = null;
    };
  }, []);
  useEffect(() => {
    const instance = editor.current;
    if (!instance) return;
    const uri = monaco.Uri.parse(`file:///practice/${id}/solution.py`);
    const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(code, 'python', uri);
    instance.setModel(model);
    return () => {
      instance.setModel(null);
      model.dispose();
    };
  }, [id]);
  useEffect(() => {
    const instance = editor.current;
    if (instance && instance.getValue() !== code) {
      const selection = instance.getSelection();
      instance
        .getModel()
        ?.pushEditOperations(
          [],
          [{ range: instance.getModel()!.getFullModelRange(), text: code }],
          () => (selection ? [selection] : []),
        );
    }
  }, [code]);
  return <div className="monaco-host" ref={element} data-testid="code-editor" />;
}
