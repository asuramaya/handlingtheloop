// THE PUBLISHED DATASET'S README — a pure function, so what we tell the world is testable.
//
// ★ IT SAID "UNKNOWN" AT THE EXACT MOMENT WE LEARNED THE NUMBER, and neither of us saw it because
// each of us was looking at our own diff. aa2316e added the caveat — truthfully: the size of
// `version`'s blind spot was unmeasured, so "an unknown number of rows" was the honest word. ea18b3c
// then measured it, computing countUnlabelledLookups twenty-nine lines above the README and using it
// nowhere. Two correct commits composed into a false sentence.
//
// It is the mirror of the defect that started this: the README asserted MORE than we knew, and the
// fix for that left it asserting LESS. Which is the generalizable part — A CAVEAT SAYING "UNKNOWN"
// IS A CLAIM WITH AN EXPIRY DATE, and the thing that expires it is usually your own next commit. So
// the number and the sentence that describes it now live in one function that cannot be changed
// independently, rather than at opposite ends of a file.
//
// `null` is a real case and stays honest rather than optimistic: countUnlabelledLookups swallows its
// own errors so an export is never lost over its footnote, and a failed count is not a count of zero.

export interface AnalysisReadmeFacts {
  tracks: number;
  /** Rows shaped like the pre-`0` lookup lane. `null` = the count did not run, NOT zero. */
  unlabelledLookups: number | null;
}

/** How the blind spot is described, given what we currently know about its size. */
function blindSpotSize(n: number | null): string {
  if (n === null) return "An unknown number of rows";
  if (n === 0) return "No rows currently in this dataset, as of the export above, look like that lane, though it";
  return `About ${n} rows (counted at export time, by the shape described below)`;
}

export function analysisReadme(f: AnalysisReadmeFacts): string {
  const size = blindSpotSize(f.unlabelledLookups);
  return (
    `---\nlicense: cc0-1.0\ntags: [music-information-retrieval, audio, bpm, key-detection]\n---\n\n` +
    `# htl analysis\n\nCrowdsourced music-information features — BPM, musical key (Camelot), and beat-grid offset — ` +
    `keyed by YouTube video id. Derived features (facts about recordings), no audio. Published by ` +
    `[Handling The Loop](https://handlingtheloop.com) — most rows measured from decoded audio by ` +
    `this project, some looked up in public databases; see \`version\` below before treating a ` +
    `row as our own measurement. ${f.tracks} tracks.\n\n` +
    `## \`version\`\n\nThe algorithm that produced the row. \`0\` means the BPM/key were NOT derived ` +
    `by this project: they were looked up in public databases (MusicBrainz → AcousticBrainz) by ` +
    `recording identifier and cached. Above \`0\`, a higher number is a later detector. Filter on ` +
    `it if you need one or the other — the two are different kinds of evidence and this dataset ` +
    `carries both.\n\n` +
    `### What \`version\` does NOT tell you\n\nThe third-party lookup lane did not stamp \`0\` ` +
    `until partway through this dataset's life; before that it wrote no version at all and took ` +
    `the column default of \`1\`. ${size} at \`version: 1\` are third-party lookups, not ` +
    `measurements from decoded audio. \`0\` is a reliable positive signal — a row marked \`0\` ` +
    `really is a lookup — but \`1\` is not a guarantee of the opposite. Rows at \`1\` carrying ` +
    `\`bpm\` or \`key\` with \`key_name\`, \`beat_offset\` and \`duration\` all null have the shape ` +
    `of that older lookup lane, and that is the filter the count above uses.\n`
  );
}
