import type { CapturePoint, HarIndex, StrategyInfo } from './types.js';

export interface CaptureStrategy {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  plan(index: HarIndex): CapturePoint[];
}

export function toStrategyInfo(strategy: CaptureStrategy): StrategyInfo {
  return {
    id: strategy.id,
    name: strategy.name,
    description: strategy.description,
  };
}
