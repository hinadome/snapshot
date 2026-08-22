export type {
  CaptureKind,
  CapturePoint,
  CaptureResult,
  DocumentNavigation,
  HarEntrySummary,
  HarIndex,
  HarPage,
  JobStatus,
  JobSummary,
  StrategyInfo,
  TimelineItem,
  WaitUntil,
} from './types.js';

export type { CaptureStrategy } from './strategy.js';
export { toStrategyInfo } from './strategy.js';

export { buildHarIndex, parseHarJson } from './har-index.js';
export type { HarFile } from './har-index.js';

export {
  DocumentNavigationStrategy,
  documentNavigationStrategy,
} from './strategies/document-navigation.js';

export {
  getStrategy,
  listStrategies,
  registerBuiltInStrategies,
  registerStrategy,
  requireStrategy,
} from './registry.js';
