import type { CaptureStrategy } from './strategy.js';
import { toStrategyInfo } from './strategy.js';
import { documentNavigationStrategy } from './strategies/document-navigation.js';
import { pageTimingStrategy } from './strategies/page-timing.js';
import { scrollViewportStrategy } from './strategies/scroll-viewport.js';
import type { StrategyInfo } from './types.js';

const registry = new Map<string, CaptureStrategy>();

export function registerStrategy(strategy: CaptureStrategy): void {
  registry.set(strategy.id, strategy);
}

export function getStrategy(id: string): CaptureStrategy | undefined {
  return registry.get(id);
}

export function listStrategies(): StrategyInfo[] {
  return [...registry.values()].map(toStrategyInfo);
}

export function requireStrategy(id: string): CaptureStrategy {
  const s = registry.get(id);
  if (!s) {
    const known = [...registry.keys()].join(', ') || '(none)';
    throw new Error(`Unknown strategy "${id}". Available: ${known}`);
  }
  return s;
}

/** Register built-in strategies. Call once at process startup. */
export function registerBuiltInStrategies(): void {
  registerStrategy(documentNavigationStrategy);
  registerStrategy(pageTimingStrategy);
  registerStrategy(scrollViewportStrategy);
}
