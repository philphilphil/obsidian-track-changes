export interface DiffRun {
  text: string;
  changed: boolean;
}

export interface CharDiff {
  oldRuns: DiffRun[];
  newRuns: DiffRun[];
}

const LCS_CAP = 250_000;

export function diffChars(oldText: string, newText: string): CharDiff {
  let p = 0;
  const minLen = Math.min(oldText.length, newText.length);
  while (p < minLen && oldText.charCodeAt(p) === newText.charCodeAt(p)) p++;

  let s = 0;
  const maxSuffix = minLen - p;
  while (
    s < maxSuffix &&
    oldText.charCodeAt(oldText.length - 1 - s) === newText.charCodeAt(newText.length - 1 - s)
  ) {
    s++;
  }

  const midOld = oldText.slice(p, oldText.length - s);
  const midNew = newText.slice(p, newText.length - s);

  const oldRuns: DiffRun[] = [];
  const newRuns: DiffRun[] = [];

  if (p > 0) {
    const common: DiffRun = { text: oldText.slice(0, p), changed: false };
    oldRuns.push(common);
    newRuns.push({ text: common.text, changed: false });
  }

  if (midOld.length > 0 && midNew.length > 0 && midOld.length * midNew.length <= LCS_CAP) {
    const [midOldRuns, midNewRuns] = lcsRuns(midOld, midNew);
    for (const r of midOldRuns) oldRuns.push(r);
    for (const r of midNewRuns) newRuns.push(r);
  } else {
    if (midOld.length > 0) oldRuns.push({ text: midOld, changed: true });
    if (midNew.length > 0) newRuns.push({ text: midNew, changed: true });
  }

  if (s > 0) {
    const common: DiffRun = { text: oldText.slice(oldText.length - s), changed: false };
    oldRuns.push(common);
    newRuns.push({ text: common.text, changed: false });
  }

  return { oldRuns: coalesce(oldRuns), newRuns: coalesce(newRuns) };
}

function lcsRuns(a: string, b: string): [DiffRun[], DiffRun[]] {
  const n = a.length;
  const m = b.length;
  const dp = new Uint32Array((n + 1) * (m + 1));
  const w = m + 1;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const idx = i * w + j;
      if (a.charCodeAt(i) === b.charCodeAt(j)) {
        dp[idx] = dp[(i + 1) * w + (j + 1)] + 1;
      } else {
        const down = dp[(i + 1) * w + j];
        const right = dp[i * w + (j + 1)];
        dp[idx] = down >= right ? down : right;
      }
    }
  }

  const aRuns: DiffRun[] = [];
  const bRuns: DiffRun[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a.charCodeAt(i) === b.charCodeAt(j)) {
      pushChar(aRuns, a[i], false);
      pushChar(bRuns, b[j], false);
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
      pushChar(aRuns, a[i], true);
      i++;
    } else {
      pushChar(bRuns, b[j], true);
      j++;
    }
  }
  while (i < n) pushChar(aRuns, a[i++], true);
  while (j < m) pushChar(bRuns, b[j++], true);
  return [aRuns, bRuns];
}

function pushChar(runs: DiffRun[], ch: string, changed: boolean): void {
  const last = runs[runs.length - 1];
  if (last && last.changed === changed) last.text += ch;
  else runs.push({ text: ch, changed });
}

function coalesce(runs: DiffRun[]): DiffRun[] {
  const out: DiffRun[] = [];
  for (const r of runs) {
    if (r.text === "") continue;
    const last = out[out.length - 1];
    if (last && last.changed === r.changed) last.text += r.text;
    else out.push({ text: r.text, changed: r.changed });
  }
  return out;
}
