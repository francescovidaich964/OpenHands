/**
 * Key-level three-way merge for `src/i18n/translation.json`.
 *
 * Why: every upstream sync stops with exactly one conflicted file, and it is always this one. The
 * fork adds its keys at the end of the top-level object and upstream does the same, so git's line
 * merge sees two edits at the same place even when the two sides touch completely different keys —
 * 2261 keys in one file, and one collision at the tail. Merging at key level is deterministic, and
 * it can never pick the wrong translation: a key both sides changed in different ways is reported as
 * a conflict instead of being guessed at.
 *
 * During a rebase git's stages are `1` = the common ancestor, `2` = "ours" = the commit being
 * rebased ONTO (upstream), `3` = "theirs" = the fork commit being replayed. So "start from ours and
 * apply theirs' changes" means: keep upstream's file (its content *and* its key order) and replay
 * the fork's key-level edits on top, which is exactly what a fork of this repo needs.
 *
 * Pure: it never touches git or the filesystem, so the same function serves the CLI
 * (`scripts/resolve-translation-conflict.mjs`) and the main process (`electron/upstream-sync.mjs`).
 */

/** The repo's format: two spaces, trailing newline, no escapes (measured on HEAD). */
export function formatTranslations(object) {
  return `${JSON.stringify(object, null, 2)}\n`;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parse plus the one structural rule this file has: a flat object of objects. */
function parseObject(text, label) {
  if (typeof text !== "string")
    return { ok: false, error: `${label}: no text` };
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `${label}: not valid JSON (${err.message})` };
  }
  if (!isPlainObject(value))
    return { ok: false, error: `${label}: not an object` };
  return { ok: true, value };
}

/**
 * Order-insensitive comparison, so a key whose translations are the same but were written in a
 * different language order does not look like an edit.
 */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort())
      out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

function sameValue(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** A key exists here or not; missing is `undefined`, never `null` (null is a real value here). */
function has(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/**
 * Merge the translation file at key level.
 *
 * @param {string|null} baseText stage 1 (the common ancestor); null when the file is new on both
 *   sides, which is treated as an empty object
 * @param {string} oursText stage 2: during a rebase this is the UPSTREAM side being rebased onto;
 *   its key order is what the output keeps
 * @param {string} theirsText stage 3: the fork commit being replayed; its key-level edits are
 *   applied on top
 * @returns {{ok: boolean, text: string|null, conflicts: string[], error: string|null,
 *   added: string[], changed: string[], removed: string[]}}
 *   `ok:false` with `conflicts` = the top-level keys both sides changed differently (the real
 *   conflicts, which need a human or the agent), or with `error` when a side cannot be read or the
 *   output format would not round-trip `oursText` (then the file is left alone rather than
 *   reformatted). `added`/`changed`/`removed` are the fork's keys the merge took, for the UI.
 */
export function mergeTranslations(baseText, oursText, theirsText) {
  const empty = {
    ok: false,
    text: null,
    conflicts: [],
    error: null,
    added: [],
    changed: [],
    removed: [],
  };

  const ours = parseObject(oursText, "ours");
  if (!ours.ok) return { ...empty, error: ours.error };
  const theirs = parseObject(theirsText, "theirs");
  if (!theirs.ok) return { ...empty, error: theirs.error };
  const base =
    baseText === null ? { ok: true, value: {} } : parseObject(baseText, "base");
  if (!base.ok) return { ...empty, error: base.error };

  // The guard the brief asks for: if the repo's own format does not round-trip this file, writing
  // would reformat all 2261 keys and turn a clean sync into a giant diff. Refuse instead.
  if (formatTranslations(ours.value) !== oursText) {
    return {
      ...empty,
      error:
        "the merge would reformat the file (it is not exactly JSON.stringify(obj, null, 2) plus a " +
        "final newline) - resolving it by hand",
    };
  }

  const [o, t, b] = [ours.value, theirs.value, base.value];
  const out = {};
  const conflicts = [];
  const added = [];
  const changed = [];
  const removed = [];

  // First pass: ours' keys, in ours' order, minus the ones theirs removes.
  for (const key of Object.keys(o)) {
    const tHas = has(t, key);
    const bHas = has(b, key);
    if (!tHas) {
      if (!bHas || sameValue(o[key], b[key])) {
        // Theirs never had it (a key upstream added): keep it. Theirs deleted it and ours did not
        // touch it: honour the deletion.
        if (bHas) removed.push(key);
        else out[key] = o[key];
        continue;
      }
      conflicts.push(key); // theirs deleted it, ours edited it
      out[key] = o[key];
      continue;
    }
    const theirsChanged = !bHas || !sameValue(t[key], b[key]);
    const oursChanged = !bHas || !sameValue(o[key], b[key]);
    if (!theirsChanged) {
      out[key] = o[key]; // theirs left it alone: ours' value wins, as in any merge
      continue;
    }
    if (sameValue(o[key], t[key])) {
      out[key] = o[key]; // both sides made the same edit
      continue;
    }
    if (!oursChanged) {
      out[key] = t[key]; // only theirs changed it
      changed.push(key);
      continue;
    }
    conflicts.push(key); // both sides changed it differently
    out[key] = o[key];
  }

  // Second pass: keys only theirs still has, appended in theirs' order (the fork's block at the
  // end of the file).
  for (const key of Object.keys(t)) {
    if (has(o, key)) continue; // pass 1 already decided it
    if (!has(b, key)) {
      out[key] = t[key];
      added.push(key); // the fork added it: it goes at the end
      continue;
    }
    // Upstream deleted this key. If the fork never touched it, the deletion stands. If the fork
    // edited it, that is the modify/delete conflict again, which nothing here may guess at.
    if (sameValue(t[key], b[key])) continue;
    conflicts.push(key);
  }

  if (conflicts.length > 0) {
    return {
      ok: false,
      text: null,
      conflicts: conflicts.sort(),
      error: null,
      added,
      changed,
      removed,
    };
  }

  const text = formatTranslations(out);
  if (text === null)
    return { ...empty, error: "the merged object cannot be serialised" };
  return {
    ok: true,
    text,
    conflicts: [],
    error: null,
    added,
    changed,
    removed,
  };
}

/**
 * The file the sync fights over, as a path inside the clone. Kept here so the main process, the CLI
 * and the task text all name the same file.
 */
export const TRANSLATION_FILE = "src/i18n/translation.json";
