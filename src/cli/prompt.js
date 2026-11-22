// Hidden input for secrets.
import { StringDecoder } from 'node:string_decoder';

const ENTER = new Set(['\r', '\n']);
const CTRL_C = '\x03';
const CTRL_D = '\x04';
const BACKSPACE = new Set(['\x7f', '\b']);
// Arrow keys, bracketed-paste markers and other terminal escape sequences.
const ESCAPE_SEQUENCE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|O[ -~])/g;
const UNFINISHED_ESCAPE = /\x1b(?:\[[0-9;?]*[ -/]*|O)?$/;

/**
 * Reads one line from a terminal, showing `*` for each character.
 * @param {{ input: NodeJS.ReadStream, output: { write(s: string): unknown }, label: string }} opts
 * @returns {Promise<string | null>} the text, or null when cancelled (Ctrl+C, Ctrl+D or end of input)
 */
export function readSecret({ input, output, label }) {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    const chars = [];
    let pending = ''; // an escape sequence split across chunks

    const finish = (settle, value) => {
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', onError);
      input.setRawMode?.(false);
      input.pause();
      output.write('\n');
      settle(value);
    };
    const onEnd = () => finish(resolve, null);
    const onError = (err) => finish(reject, err);
    const onData = (chunk) => {
      let text = pending + (typeof chunk === 'string' ? chunk : decoder.write(chunk));
      pending = '';
      const unfinished = text.match(UNFINISHED_ESCAPE);
      if (unfinished) {
        pending = unfinished[0];
        text = text.slice(0, unfinished.index);
      }
      for (const ch of text.replace(ESCAPE_SEQUENCE, '')) {
        if (ENTER.has(ch)) { finish(resolve, chars.join('')); return; }
        if (ch === CTRL_C || (ch === CTRL_D && chars.length === 0)) { finish(resolve, null); return; }
        if (BACKSPACE.has(ch)) {
          if (chars.length) { chars.pop(); output.write('\b \b'); }
        } else if (ch >= ' ') {
          chars.push(ch);
          output.write('*');
        }
      }
    };

    output.write(label);
    input.setRawMode?.(true);
    input.on('data', onData);
    input.on('end', onEnd);
    input.on('error', onError);
    input.resume();
  });
}
