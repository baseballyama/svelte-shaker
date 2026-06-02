// Minimal LCS line diff — enough to render "what the shaker removed".
export type DiffKind = 'keep' | 'del' | 'add';
export interface DiffLine {
  kind: DiffKind;
  text: string;
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.replace(/\n+$/, '').split('\n');
  const b = after.replace(/\n+$/, '').split('\n');
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i]![j] =
        a[i] === b[j]
          ? dp[i + 1]![j + 1]! + 1
          : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ kind: 'keep', text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: 'del', text: a[i]! });
      i++;
    } else {
      out.push({ kind: 'add', text: b[j]! });
      j++;
    }
  }
  while (i < m) out.push({ kind: 'del', text: a[i++]! });
  while (j < n) out.push({ kind: 'add', text: b[j++]! });

  // Collapse long runs of unchanged lines into a fold marker for readability.
  return collapse(out);
}

function collapse(lines: DiffLine[], context = 2): DiffLine[] {
  const changed = lines.map((l) => l.kind !== 'keep');
  const keep = new Array(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (changed[i])
      for (let k = -context; k <= context; k++)
        if (i + k >= 0 && i + k < lines.length) keep[i + k] = true;
  }
  const out: DiffLine[] = [];
  let hidden = 0;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      if (hidden > 0) {
        out.push({ kind: 'keep', text: `⋯ ${hidden} unchanged line${hidden > 1 ? 's' : ''}` });
        hidden = 0;
      }
      out.push(lines[i]!);
    } else hidden++;
  }
  if (hidden > 0)
    out.push({ kind: 'keep', text: `⋯ ${hidden} unchanged line${hidden > 1 ? 's' : ''}` });
  return out;
}

export function hasChanges(lines: DiffLine[]): boolean {
  return lines.some((l) => l.kind !== 'keep');
}
