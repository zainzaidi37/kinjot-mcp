// Reads one secret line (an API key) from a terminal with no echo, or from a
// piped stream when stdin isn't a TTY. Everything is passed in — no direct
// reference to process.stdin/stdout — so this is testable without a real pty.

export class HiddenLineAbortedError extends Error {
  constructor(message = 'input cancelled') {
    super(message);
    this.name = 'HiddenLineAbortedError';
  }
}

export interface ReadHiddenLineOptions {
  input: NodeJS.EventEmitter & {
    setRawMode?: (mode: boolean) => void;
    pause?: () => unknown;
    resume?: () => unknown;
  };
  output: { write: (chunk: string) => unknown };
  isTTY: boolean;
  prompt: string;
}

// A terminal left in bracketed-paste mode (xterm's `CSI 200 ~` / `CSI 201 ~`)
// wraps a paste in these markers. Only the two whole sequences go, so a project
// URL keeps its `[` and `~`, and `NON_KEY_CHARS` (and `readTtySetup`'s copy in
// `cli.ts`) cannot keep their digits (#1500). A Backspace strips them first:
// the last byte after a paste is the end marker's `~`.
export function withoutPasteMarkers(text: string): string {
  return text.replaceAll('\x1b[200~', '').replaceAll('\x1b[201~', '');
}

// Drops anything else non-key-shaped that can ride along in a pasted chunk;
// `API_KEY_PATTERN` (`config.ts`) admits only letters, digits and underscores.
const NON_KEY_CHARS = /[^A-Za-z0-9_]/g;

export function readHiddenLine({
  input,
  output,
  isTTY,
  prompt,
}: ReadHiddenLineOptions): Promise<string> {
  output.write(prompt);

  return new Promise<string>((resolve, reject) => {
    let buffer = '';
    let settled = false;

    // Every terminal path below (finish/abort) runs cleanup() exactly once —
    // this is the event-driven equivalent of a try/finally: setRawMode(false)
    // is restored on success, cancellation, error, and stream end alike.
    function cleanup(): void {
      input.removeListener?.('data', onData);
      input.removeListener?.('end', onEnd);
      input.removeListener?.('error', onError);
      if (isTTY) input.setRawMode?.(false);
      input.pause?.();
    }

    function finish(value: string): void {
      if (settled) return;
      settled = true;
      cleanup();
      output.write('\n');
      resolve(withoutPasteMarkers(value).replace(NON_KEY_CHARS, ''));
    }

    function abort(error: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      output.write('\n');
      reject(error);
    }

    function onData(chunk: Buffer | string): void {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');

      if (!isTTY) {
        // Piped stdin: no control-character handling, just find one line.
        const newline = text.indexOf('\n');
        if (newline === -1) {
          buffer += text;
          return;
        }
        buffer += text.slice(0, newline);
        finish(buffer.replace(/\r$/, ''));
        return;
      }

      // Paste can arrive as a single multi-char chunk that itself contains
      // the terminator, so we always process it character by character
      // rather than assuming one chunk == one keystroke.
      for (const ch of text) {
        if (ch === '\x03') {
          abort(new HiddenLineAbortedError());
          return;
        }
        if (ch === '\r' || ch === '\n' || ch === '\x04') {
          finish(buffer);
          return;
        }
        if (ch === '\x7f' || ch === '\x08') {
          buffer = withoutPasteMarkers(buffer).slice(0, -1);
          continue;
        }
        buffer += ch;
      }
    }

    function onEnd(): void {
      finish(buffer);
    }

    function onError(error: Error): void {
      abort(error);
    }

    if (isTTY) input.setRawMode?.(true);
    input.resume?.();
    input.on('data', onData);
    input.on('end', onEnd);
    input.on('error', onError);
  });
}
