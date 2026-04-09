import * as pty from 'node-pty';
import { IPty, IEvent } from 'node-pty';
import os from 'os';
import process from 'process';
import { SessionEvent } from '../adapters/types.js';

export interface PtyOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd: string;
  env?: Record<string, string>;
  encoding?: string;
  handleFlowControl?: boolean;
}

export interface PtyProcess {
  pty: IPty;
  onData: IEvent<string>;
  onExit: IEvent<{ exitCode: number; signal?: number }>;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export class PtyRuntime {
  private static isWindows = os.platform() === 'win32';

  /**
   * Spawns a new PTY process.
   * On Windows, it uses ConPTY by default (as per node-pty >= 0.9).
   */
  public static spawn(
    file: string,
    args: string[] | string,
    options: PtyOptions
  ): PtyProcess {
    const shell = file || (this.isWindows ? 'powershell.exe' : 'bash');

    const ptyProcess = pty.spawn(shell, args, {
      name: options.name || 'xterm-256color',
      cols: options.cols || 80,
      rows: options.rows || 24,
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      encoding: options.encoding,
      handleFlowControl: options.handleFlowControl
    });

    return {
      pty: ptyProcess,
      onData: ptyProcess.onData,
      onExit: ptyProcess.onExit,
      write: (data: string) => ptyProcess.write(data),
      resize: (cols: number, rows: number) => ptyProcess.resize(cols, rows),
      kill: (signal?: string) => ptyProcess.kill(signal)
    };
  }

  /**
   * Translates raw PTY output into canonical Aladeen session events.
   */
  public static createEventTransformer(
    emit: (event: SessionEvent) => void
  ) {
    return {
      onData: (data: string) => {
        // Simple heuristic: if it looks like stderr (depending on provider), 
        // we might handle differently, but standard PTY mixes stdout and stderr.
        // For baseline, we treat all as stdout_chunk.
        emit({ type: 'stdout_chunk', content: data });
      },
      onExit: (exitCode: number) => {
        emit({ type: 'status_event', status: exitCode === 0 ? 'stopped' : 'errored' });
      }
    };
  }

  /**
   * Validates if the current host environment can support PTY sessions.
   */
  public static async checkCompatibility(): Promise<{
    compatible: boolean;
    reason?: string;
  }> {
    try {
      // node-pty should handle the platform specifics. 
      // If it loaded correctly in this environment, it's a good sign.
      if (this.isWindows) {
        // ConPTY requires Windows 10 build 18362+
        const release = os.release().split('.');
        const build = parseInt(release[2] || '0');
        if (build < 18362) {
          return {
            compatible: false,
            reason: `Windows build: ${os.release()} is too old for ConPTY (requires 18362+).`
          };
        }
      }
      return { compatible: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { compatible: false, reason: message };
    }
  }
}
