import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// THE POPULATION A SOURCE SCAN DRAWS FROM, in one place, because getting it wrong is this repo's
// most repeated test defect and it fails in the one direction nobody checks: silently green.
//
// Three scans had to be widened in a single evening, and the third widening reproduced the first
// bug on a different axis — a walk that had just been widened from one DIRECTORY to all of src/
// still filtered on `/\.ts$/`, so every .tsx file stayed outside the population, inside the fix for
// exactly that mistake. A scan that excludes the place a defect can live is the wrong-rows error in
// test form: it reports a clean result about rows it never read, and nothing in the output says so.
//
// So the walk is written ONCE. A new scan cannot be born narrow, and an axis we have not thought of
// yet gets fixed here rather than in each copy.

// TEST-ONLY. It reads the filesystem, so nothing in the app may import it — a build that pulls
// node:fs into the browser bundle is the failure, and it is loud rather than silent.
export interface SourceFile {
  /** Path relative to the scan root, with forward slashes — what a failure message should name. */
  path: string;
  src: string;
}

/** Every non-test TypeScript source under `root`, recursively, .ts AND .tsx. */
export function sourceFiles(root: string): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, `${prefix}${e.name}/`);
      else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name)) out.push({ path: `${prefix}${e.name}`, src: readFileSync(p, "utf8") });
    }
  };
  walk(root, "");
  return out;
}

/** Source with block and line comments removed — a scan looking for CODE should not match prose
 *  about that code, and several of these scans describe their own pattern in their own header. */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
