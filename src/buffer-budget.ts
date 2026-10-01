export class BufferBudgetError extends Error {
  readonly code = 'ERR_BUFFER_BUDGET';
  constructor(public readonly limit: number, public readonly actual: number) {
    super(`Buffered resource reservations ${actual} exceed maxBufferedBytes ${limit}`);
    this.name = 'BufferBudgetError';
  }
}

/** Worker implementations use acknowledged parent RPC for the same operations. */
export interface BufferAccount {
  observeBody(bytes: number): void | Promise<void>;
  reserveChild(bytes: number): void | Promise<void>;
}

/** Parent-thread ledger. Workers request reservations; they never mutate counters. */
export class BufferBudget {
  private _used = 0;
  private _peak = 0;
  get used(): number { return this._used; }
  get peak(): number { return this._peak; }
  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Invalid buffered-byte limit');
  }

  reserve(bytes: number): BufferReservation {
    this.acquire(bytes);
    return new BufferReservation(this, bytes);
  }

  /** Internal accounting operations; all updates are synchronous in the parent. */
  acquire(bytes: number): void {
    validateBytes(bytes);
    if (bytes > this.limit - this._used) throw new BufferBudgetError(this.limit, this._used + bytes);
    this._used += bytes;
    this._peak = Math.max(this._peak, this._used);
  }
  release(bytes: number): void {
    validateBytes(bytes);
    if (bytes > this._used) throw new RangeError('Buffered-byte reservation underflow');
    this._used -= bytes;
  }
}

function validateBytes(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('Invalid buffered-byte reservation');
}

/** Holds a task's body high-water mark plus separately transferable child bodies. */
export class BufferReservation {
  private closed = false;
  private children = 0;
  get childBytes(): number { return this.children; }
  constructor(private readonly budget: BufferBudget, private body: number) {}

  observeBody(bytes: number): void {
    this.assertOpen();
    validateBytes(bytes);
    if (bytes <= this.body) return;
    this.budget.acquire(bytes - this.body);
    this.body = bytes;
  }

  reserveChild(bytes: number): void {
    this.assertOpen();
    this.budget.acquire(bytes);
    this.children += bytes;
  }

  /** Move already-reserved bytes into an admitted child without double charging. */
  takeChild(bytes: number): BufferReservation {
    this.assertOpen();
    validateBytes(bytes);
    if (bytes > this.children) throw new RangeError('Child body exceeds reserved bytes');
    this.children -= bytes;
    return new BufferReservation(this.budget, bytes);
  }

  release(): void {
    if (this.closed) return;
    this.closed = true;
    this.budget.release(this.body + this.children);
    this.body = this.children = 0;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Buffered-byte reservation is closed');
  }
}
