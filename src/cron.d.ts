// Portable UNIX-cron schedule evaluator types (browser-safe, no imports).

export type CronSchedule = {
  expression: string;
  timeZone: string;
};

export const CRON_TRIGGER_EVENT_TYPES: readonly ["cron.tick"];

export function validateCronSchedule(value: unknown): CronSchedule;
export function nextCronOccurrence(schedule: CronSchedule, afterMs: number): number;
export function latestCronOccurrence(schedule: CronSchedule, atOrBeforeMs: number): number;
