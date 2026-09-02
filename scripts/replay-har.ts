#!/usr/bin/env node
/**
 * Thin CLI for HAR replay — uses the same engine as the web app.
 *
 * Examples:
 *   pnpm replay -- path/to/site.har
 *   pnpm replay -- --strategy page-timing path/to/site.har
 *   pnpm replay -- --scroll path/to/site.har
 *   pnpm replay -- path/to/session.har.zip
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  registerBuiltInStrategies,
  buildHarIndex,
  parseHarJson,
  requireStrategy,
  listStrategies,
} from '@snapshot/core';
import {
  openInputPath,
  executeCapturePlan,
  closeBrowser,
  describeHarSource,
} from '@snapshot/replay';

function usage(code = 1): never {
  registerBuiltInStrategies();
  const strategies = listStrategies()
    .map((s) => `    ${s.id.padEnd(22)} ${s.description}`)
    .join('\n');
  console.error(`Usage: pnpm replay -- [options] <path>

Options:
  --strategy <id>   Capture strategy (default: document-navigation)
  --scroll          Shortcut for --strategy scroll-viewport
  --har <path>      Explicit .har path
  --file <path>     Auto-detect input format
  --headless        Headless browser (default for batch capture)
  --no-cors         Disable browser-faithful CORS during replay (serve all HAR hits)
  --out <dir>       Screenshot output directory (default: ./har-screenshots)
  -h, --help        Show help

Strategies:
${strategies}`);
  process.exit(code);
}

function parseArgs(argv: string[]) {
  const opts = {
    path: null as string | null,
    strategyId: 'document-navigation',
    headless: true,
    enforceCors: true,
    out: join(process.cwd(), 'har-screenshots'),
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-h' || a === '--help') usage(0);
    if (a === '--strategy') opts.strategyId = argv[++i] ?? usage();
    else if (a === '--scroll') opts.strategyId = 'scroll-viewport';
    else if (a === '--har' || a === '--file') opts.path = argv[++i] ?? usage();
    else if (a === '--headless') opts.headless = true;
    else if (a === '--no-cors') opts.enforceCors = false;
    else if (a === '--out') opts.out = resolve(argv[++i] ?? usage());
    else if (!a.startsWith('-')) opts.path = a;
    else usage();
  }

  if (!opts.path) {
    console.error('Missing input path');
    usage();
  }
  return opts;
}

async function main() {
  registerBuiltInStrategies();
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const opts = parseArgs(args);
  const input = openInputPath(opts.path!);

  try {
    console.log(`Input: ${opts.path}`);
    console.log(`  kind: ${input.kind}`);
    console.log(`  source: ${describeHarSource(input.sourceInfo)}`);
    console.log(
      `  entries: ${input.sourceInfo.entryCount} (bodies: ${input.sourceInfo.bodyCoveragePct}%)`,
    );
    console.log(`  strategy: ${opts.strategyId}`);
    console.log(`  CORS: ${opts.enforceCors ? 'enforced' : 'off (--no-cors)'}`);

    const raw = parseHarJson(readFileSync(input.harPath, 'utf8'));
    const index = buildHarIndex(raw);
    const strategy = requireStrategy(opts.strategyId);
    const points = strategy.plan(index);

    if (points.length === 0) {
      throw new Error('No capture points for this HAR and strategy');
    }

    console.log(`\nCapturing ${points.length} frame(s) → ${opts.out}\n`);
    mkdirSync(opts.out, { recursive: true });

    const results = await executeCapturePlan(
      input.harPath,
      points,
      (id) => join(opts.out, `${id}.png`),
      {
        harDir: input.harDir,
        headless: opts.headless,
        enforceCors: opts.enforceCors,
        onProgress: (_c, _t, label) => {
          console.log(`… ${label}`);
        },
      },
    );

    for (const result of results) {
      console.log(`→ ${result.label}`);
      if (result.warnings.length) {
        for (const w of result.warnings) {
          for (const line of w.split('\n')) console.warn(`  warn: ${line}`);
        }
      }
      if (result.error) console.error(`  error: ${result.error}`);
      else console.log(`  saved: ${result.screenshotPath}`);
    }
  } finally {
    input.cleanup?.();
    await closeBrowser();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
