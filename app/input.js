/** Accept a character into the current logical line; paper retains every strike. */
export function acceptCharacter(line, key) {
  // CTSS deletes the current line, including the question mark itself.
  if (line.questionDeletes && key === '?') {
    line.text = '';
    return true;
  }
  if (line.terse && line.text.length >= 72) return false;
  line.text += key;
  return true;
}
