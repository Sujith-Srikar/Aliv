export const MAX_MONITORS_PER_USER = 20;

export class MonitorLimitError extends Error {
  constructor(
    public readonly limit: number,
    message = `user has reached the maximum number of monitors (${MAX_MONITORS_PER_USER})`,
  ) {
    super(message);
  }
}
