import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { unzipSync } from 'fflate';
import { inspectHarData } from '../inspect/har-info.js';

export const MAX_INPUT_BYTES = 200 * 1024 * 1024;

export type NormalizedInput = {
  harPath: string;
  format: 'har' | 'zip';
  kind: string;
  /** Directory containing the HAR and any Playwright `_file` body sidecars */
  harDir: string;
  cleanup: (() => void) | null;
  sourceInfo: ReturnType<typeof inspectHarData>;
};

function assertSize(buf: Buffer, label: string): void {
  if (buf.byteLength > MAX_INPUT_BYTES) {
    throw new Error(`${label} exceeds ${MAX_INPUT_BYTES / (1024 * 1024)}MB limit`);
  }
}

function isZipBuffer(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b;
}

function writeTempHar(harJsonText: string): {
  harPath: string;
  cleanupDir: string;
} {
  const cleanupDir = mkdtempSync(join(tmpdir(), 'snapshot-har-'));
  const harPath = join(cleanupDir, 'session.har');
  writeFileSync(harPath, harJsonText, 'utf8');
  return { harPath, cleanupDir };
}

/**
 * Extract a Playwright / URL-checker HAR zip.
 *
 * Layout:
 *   export.har.zip
 *   ├── har.har           # HAR JSON; bodies referenced via content._file
 *   └── <hash> / *.js …   # raw response body files
 *
 * All entries are written so `_file` sidecars resolve next to the HAR.
 * Also writes `capture.har` (copy of the HAR JSON) for job conventions.
 */
export function extractHarZipToDir(buf: Buffer, destDir: string): string {
  mkdirSync(destDir, { recursive: true });
  const files = unzipSync(buf);
  const names = Object.keys(files);

  const harEntryName =
    names.find((n) => /(^|\/)har\.har$/i.test(n)) ??
    names.find((n) => n.toLowerCase().endsWith('.har') && !n.endsWith('/')) ??
    names.find((n) => n.toLowerCase().includes('har') && !n.endsWith('/'));

  if (!harEntryName) {
    throw new Error('Zip archive contains no .har / har.har file');
  }

  const destRoot = resolve(destDir);

  for (const name of names) {
    if (!name || name.endsWith('/')) continue;
    const data = files[name];
    if (!data) continue;

    // Zip-slip protection
    const outPath = resolve(destDir, name);
    const rel = relative(destRoot, outPath);
    if (rel.startsWith('..') || rel.includes(`..${sep}`)) {
      throw new Error(`Refusing unsafe zip entry path: ${name}`);
    }

    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, data);
  }

  const extractedHarPath = resolve(destDir, harEntryName);
  const capturePath = join(destDir, 'capture.har');
  if (extractedHarPath !== resolve(capturePath)) {
    writeFileSync(capturePath, readFileSync(extractedHarPath));
  }

  return capturePath;
}

function writeTempZipFromBase64(b64: string): {
  harPath: string;
  cleanupDir: string;
} {
  const cleanupDir = mkdtempSync(join(tmpdir(), 'snapshot-har-b64-'));
  const buf = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
  assertSize(buf, 'Decoded base64');
  if (isZipBuffer(buf)) {
    const harPath = extractHarZipToDir(buf, cleanupDir);
    return { harPath, cleanupDir };
  }
  const harPath = join(cleanupDir, 'session.har');
  writeFileSync(harPath, buf);
  return { harPath, cleanupDir };
}

export function resolveSessionInput(
  input: string,
  options: { sourcePath?: string | null } = {},
): NormalizedInput {
  const text = String(input).trim();
  if (!text) throw new Error('Empty session input');

  if (text.startsWith('{')) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `Invalid JSON: ${err instanceof Error ? err.message : err}`,
      );
    }

    const log = data.log as { entries?: unknown[] } | undefined;
    if (log && Array.isArray(log.entries)) {
      if (options.sourcePath && fileExists(options.sourcePath)) {
        return finalizeHarPath(resolve(options.sourcePath), 'har');
      }
      const { harPath, cleanupDir } = writeTempHar(text);
      return finalizeHarPath(harPath, 'har', cleanupDir);
    }

    if (typeof data.harZipBase64 === 'string' && data.harZipBase64) {
      const { harPath, cleanupDir } = writeTempZipFromBase64(data.harZipBase64);
      return finalizeHarPath(harPath, 'zip', cleanupDir, 'harZipBase64');
    }

    if (typeof data.har === 'string' && data.har.trim().startsWith('{')) {
      const { harPath, cleanupDir } = writeTempHar(data.har);
      return finalizeHarPath(harPath, 'har', cleanupDir, 'har');
    }

    if (data.harError) {
      throw new Error(`Check result has harError: ${String(data.harError)}`);
    }

    throw new Error(
      'JSON is not a HAR and has no harZipBase64/har field',
    );
  }

  if (text.startsWith('data:')) {
    const comma = text.indexOf(',');
    if (comma === -1) throw new Error('Invalid data URL');
    const { harPath, cleanupDir } = writeTempZipFromBase64(text.slice(comma + 1));
    return finalizeHarPath(harPath, 'zip', cleanupDir, 'harZipBase64');
  }

  const { harPath, cleanupDir } = writeTempZipFromBase64(text);
  return finalizeHarPath(harPath, 'zip', cleanupDir, 'harZipBase64');
}

function fileExists(p: string): boolean {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}

function finalizeHarPath(
  harPath: string,
  format: 'har' | 'zip',
  cleanupDir?: string,
  kind = 'har',
): NormalizedInput {
  const raw = readFileSync(harPath, 'utf8');
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Not valid HAR JSON: ${err instanceof Error ? err.message : err}`,
    );
  }
  const sourceInfo = inspectHarData(data);
  if (sourceInfo.entryCount === 0) {
    throw new Error(
      'HAR has 0 entries. Export “Save all as HAR with content” from DevTools.',
    );
  }
  validateHarSourceInfo(sourceInfo);

  return {
    harPath: resolve(harPath),
    format,
    kind,
    harDir: dirname(resolve(harPath)),
    cleanup: cleanupDir
      ? () => rmSync(cleanupDir, { recursive: true, force: true })
      : null,
    sourceInfo,
  };
}

export function validateHarSourceInfo(
  info: ReturnType<typeof inspectHarData>,
  options: { requireDocument?: boolean } = {},
): void {
  if (!info.hasDocument && options.requireDocument !== false) {
    throw new Error(
      'No document/HTML entry in this HAR. Re-export after a full page load ' +
        'with “Save all as HAR with content”, or pass an explicit URL.',
    );
  }
  if (info.bodyCoveragePct < 20) {
    console.warn(
      `Warning: low body coverage (${info.bodyCoveragePct}%). ` +
        'Use “Save all as HAR with content” for better replay.',
    );
  }
}

export function openInputPath(filePath: string): NormalizedInput {
  const abs = resolve(filePath);
  const buf = readFileSync(abs);
  assertSize(buf, basename(abs));

  const ext = extname(abs).toLowerCase();
  const name = basename(abs).toLowerCase();

  if (ext === '.zip' || name.endsWith('.har.zip') || isZipBuffer(buf)) {
    const cleanupDir = mkdtempSync(join(tmpdir(), 'snapshot-har-zip-'));
    const harPath = extractHarZipToDir(buf, cleanupDir);
    return finalizeHarPath(harPath, 'zip', cleanupDir, 'zip');
  }

  const text = buf.toString('utf8');
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    if (trimmed.includes('"log"') && trimmed.includes('"entries"')) {
      return finalizeHarPath(abs, 'har', undefined, 'har');
    }
    return resolveSessionInput(trimmed, { sourcePath: abs });
  }

  return resolveSessionInput(trimmed);
}

function copyDirFiles(srcDir: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  const srcRoot = resolve(srcDir);
  const destRoot = resolve(destDir);

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const from = join(dir, entry);
      const st = statSync(from);
      const rel = relative(srcRoot, from);
      const to = join(destRoot, rel);
      if (st.isDirectory()) {
        mkdirSync(to, { recursive: true });
        walk(from);
      } else if (st.isFile()) {
        mkdirSync(dirname(to), { recursive: true });
        // Don't clobber dest capture.har if we already wrote it; still OK to overwrite with same
        copyFileSync(from, to);
      }
    }
  };

  walk(srcRoot);
}

/**
 * Persist HAR (+ Playwright zip body sidecars) into the job directory.
 * `destPath` is the capture.har path (e.g. data/jobs/<id>/capture.har).
 */
export function persistNormalizedHar(
  input: NormalizedInput,
  destPath: string,
): void {
  const destDir = dirname(destPath);
  mkdirSync(destDir, { recursive: true });

  const srcDir = resolve(input.harDir);
  const destRoot = resolve(destDir);

  if (srcDir === destRoot) {
    // Already in place (e.g. extracted directly into job dir)
    if (resolve(input.harPath) !== resolve(destPath)) {
      writeFileSync(destPath, readFileSync(input.harPath));
    }
    return;
  }

  // Copy HAR JSON + any sibling assets (_file bodies, nested paths)
  copyDirFiles(srcDir, destDir);

  // Ensure canonical capture.har exists even if source was har.har / session.har
  if (resolve(input.harPath) !== resolve(destPath)) {
    writeFileSync(destPath, readFileSync(input.harPath));
  }
}

export function openInputBuffer(
  buf: Buffer,
  originalFilename: string,
): NormalizedInput {
  assertSize(buf, originalFilename);
  const cleanupDir = mkdtempSync(join(tmpdir(), 'snapshot-upload-'));
  const name = (originalFilename || '').toLowerCase();

  if (name.endsWith('.zip') || name.endsWith('.har.zip') || isZipBuffer(buf)) {
    const harPath = extractHarZipToDir(buf, cleanupDir);
    return finalizeHarPath(harPath, 'zip', cleanupDir, 'zip');
  }

  const dest = join(cleanupDir, originalFilename || 'upload');
  writeFileSync(dest, buf);

  const trimmed = buf.toString('utf8').trim();
  if (trimmed.startsWith('{')) {
    if (trimmed.includes('"log"') && trimmed.includes('"entries"')) {
      const harPath = join(cleanupDir, 'capture.har');
      writeFileSync(harPath, trimmed, 'utf8');
      return finalizeHarPath(harPath, 'har', cleanupDir, 'har');
    }
    const resolved = resolveSessionInput(trimmed);
    const priorCleanup = resolved.cleanup;
    resolved.cleanup = () => {
      priorCleanup?.();
      rmSync(cleanupDir, { recursive: true, force: true });
    };
    return resolved;
  }

  try {
    const resolved = resolveSessionInput(trimmed);
    const priorCleanup = resolved.cleanup;
    resolved.cleanup = () => {
      priorCleanup?.();
      rmSync(cleanupDir, { recursive: true, force: true });
    };
    return resolved;
  } catch {
    rmSync(cleanupDir, { recursive: true, force: true });
    throw new Error(
      'Upload must be a .har, .har.zip, check-result JSON, or harZipBase64 text',
    );
  }
}
