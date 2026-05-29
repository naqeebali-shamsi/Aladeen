import spawn from 'cross-spawn';

// Open a URL in the user's default browser, cross-platform, with NO npm
// dependency (we already vendor cross-spawn for the adapters). Best-effort:
// failure is non-fatal because the CLI has already printed the URL.
//
// Windows note: `start` is a cmd builtin, not an exe, and its first quoted
// argument is treated as the window title — so we pass an empty title `""`
// before the URL or the browser silently opens nothing.
export async function openBrowser(url: string): Promise<boolean> {
  const platform = process.platform;
  let command: string;
  let args: string[];

  if (platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { stdio: 'ignore', detached: false });
      child.on('error', () => resolve(false));
      child.on('spawn', () => resolve(true));
      // Some platforms exit immediately; treat a clean exit as success too.
      child.on('exit', (code) => resolve(code === 0 || code === null));
    } catch {
      resolve(false);
    }
  });
}
