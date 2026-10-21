/** Copy platform values, not provider credentials or unrelated shell variables. */
export function desktopEnvironment(
  data: string,
  developmentUrl: string,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const allowed = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'LOCALAPPDATA',
    'APPDATA',
    'PROGRAMDATA',
    'HOMEDRIVE',
    'HOMEPATH',
    'COMSPEC',
    'PATHEXT',
    'DISPLAY',
    'XAUTHORITY',
    'WAYLAND_DISPLAY',
    'XDG_RUNTIME_DIR',
    'XDG_SESSION_TYPE',
    'XDG_DATA_DIRS',
    'DBUS_SESSION_BUS_ADDRESS',
    'PULSE_SERVER',
    'INTERVIEW_DESKTOP_PYTHON',
  ];
  return {
    ...Object.fromEntries(
      allowed.flatMap((name) => (source[name] === undefined ? [] : [[name, source[name]!]])),
    ),
    INTERVIEW_DESKTOP_DATA_DIR: data,
    INTERVIEW_DESKTOP_PROBLEMS_DIR: '',
    INTERVIEW_DESKTOP_DEV_URL: developmentUrl,
  };
}
