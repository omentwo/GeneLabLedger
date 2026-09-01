export type LedgerCellEditState = "clear" | "dirty";
export type LedgerCellCompletionAction = "none" | "clear" | "pending" | "resave";

export function resolveLedgerCellEditState(
  currentValue: string,
  persistedValue: string,
  inFlightCount: number,
): LedgerCellEditState {
  return currentValue === persistedValue && inFlightCount === 0 ? "clear" : "dirty";
}

export function resolveLedgerCellCompletionAction(input: {
  completedVersion: number;
  currentVersion: number | undefined;
  currentValue: string;
  persistedValue: string;
  inFlightCount: number;
}): LedgerCellCompletionAction {
  if (input.currentVersion === input.completedVersion) return "none";
  if (input.inFlightCount > 0) return "pending";
  if (input.currentValue === input.persistedValue) return "clear";
  return "resave";
}

export interface LatestValuePersistenceOptions<T> {
  initialValue: T;
  save: (value: T) => Promise<T>;
  apply: (value: T) => void;
  onLatestError: (error: unknown) => void;
}

export class LatestValuePersistence<T> {
  private committedValue: T;
  private latestValue: T;
  private requestedRevision = 0;
  private handledRevision = 0;
  private running: Promise<void> | null = null;

  constructor(private readonly options: LatestValuePersistenceOptions<T>) {
    this.committedValue = options.initialValue;
    this.latestValue = options.initialValue;
  }

  syncCommittedValue(value: T): void {
    if (this.running || this.requestedRevision !== this.handledRevision) return;
    this.committedValue = value;
    this.latestValue = value;
  }

  request(value: T): void {
    this.latestValue = value;
    this.requestedRevision += 1;
    this.options.apply(value);
    this.ensureRunning();
  }

  async whenIdle(): Promise<void> {
    while (this.running) await this.running;
  }

  private ensureRunning(): void {
    if (this.running) return;
    this.running = this.run().finally(() => {
      this.running = null;
      if (this.handledRevision < this.requestedRevision) this.ensureRunning();
    });
  }

  private async run(): Promise<void> {
    while (this.handledRevision < this.requestedRevision) {
      const revision = this.requestedRevision;
      const requestedValue = this.latestValue;
      try {
        const savedValue = await this.options.save(requestedValue);
        this.committedValue = savedValue;
        this.handledRevision = revision;
        if (revision === this.requestedRevision) {
          this.latestValue = savedValue;
          this.options.apply(savedValue);
        }
      } catch (error) {
        this.handledRevision = revision;
        if (revision === this.requestedRevision) {
          this.latestValue = this.committedValue;
          this.options.apply(this.committedValue);
          this.options.onLatestError(error);
        }
      }
    }
  }
}
