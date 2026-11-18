// Document transactions for callback/transport tests. Native CodeMirror transaction,
// history and syntax tests live separately; this is not a DOM or editor simulator.
export const lf = value => value.replace(/\r\n?/g, '\n');
export function transaction(before, after, { beforeVersion = {}, version = {}, origin = 'input.type', changes, payload } = {}) {
  before = lf(before); after = lf(after);
  if (!changes) {
    let from = 0, endA = before.length, endB = after.length;
    while (from < endA && from < endB && before[from] === after[from]) from++;
    while (endA > from && endB > from && before[endA - 1] === after[endB - 1]) { endA--; endB--; }
    changes = from === endA && from === endB ? [] : [{ from, to: endA, insert: after.slice(from, endB) }];
  }
  return { before, text: after, beforeVersion, version, origin, changes, ...(payload ? { payload } : {}) };
}
