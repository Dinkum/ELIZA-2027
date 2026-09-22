/** The fixed demonstration account restored with the reconstructed CTSS disk. */
const LOGIN = [
  { prompt: /\bREADY\./i, line: 'LOGIN ELIZA' },
  { prompt: /\bPASSWORD\b/i, line: 'ELIZA' },
];

/** CTSS command level, reached only after the account has logged in. */
const COMMAND_PROMPT = /(?:^|\n)\s*R\s+\d+\.\d+\+\.\d+/i;

const matches = (pattern, text) => {
  pattern.lastIndex = 0;
  return pattern.test(text);
};

/**
 * A small rolling view of the terminal output, with waits that also work when
 * a prompt is divided between worker messages.
 */
export class CtssOutput {
  constructor(limit = 16384) {
    this.limit = limit;
    this.text = '';
    this.waiters = [];
  }

  push(text) {
    this.text = (this.text + String(text)).slice(-this.limit);
    const ready = this.waiters.filter(({ pattern }) => matches(pattern, this.text));
    this.waiters = this.waiters.filter((waiter) => !ready.includes(waiter));
    ready.forEach(({ resolve }) => resolve());
  }

  waitFor(pattern) {
    if (matches(pattern, this.text)) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ pattern, resolve }));
  }
}

/**
 * Type the reconstructed disk's public demonstration credentials, then stop
 * at command level so the visitor still chooses ELIZA and its script.
 */
export async function logInToCtss(output, typeLine) {
  for (const step of LOGIN) {
    await output.waitFor(step.prompt);
    if (!(await typeLine(step.line))) return false;
  }
  await output.waitFor(COMMAND_PROMPT);
  return true;
}
