/**
 * Circuit Breaker for MCP server connections.
 *
 * States:
 * - CLOSED:    Normal operation – requests flow through.
 * - OPEN:      Too many consecutive failures – requests fail fast.
 * - HALF_OPEN: After a cooldown period, one probe request is allowed to test recovery.
 */

export enum CircuitState {
  CLOSED = "closed",
  OPEN = "open",
  HALF_OPEN = "half-open",
}

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before opening the circuit. Default: 3 */
  failureThreshold?: number;
  /** Time in ms to wait before transitioning from OPEN → HALF_OPEN. Default: 5 min */
  resetTimeoutMs?: number;
}

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_RESET_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private consecutiveFailures = 0;
  private lastFailureTime = 0;
  private probeInFlight = false;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;

  constructor(
    private readonly name: string,
    options?: CircuitBreakerOptions,
  ) {
    this.failureThreshold =
      options?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.resetTimeoutMs = options?.resetTimeoutMs ?? DEFAULT_RESET_TIMEOUT_MS;
  }

  /**
   * Returns true if the request should be allowed through.
   * In HALF_OPEN state, only the first caller gets the probe token.
   */
  canAttempt(): boolean {
    switch (this.state) {
      case CircuitState.CLOSED:
        return true;
      case CircuitState.OPEN: {
        const elapsed = Date.now() - this.lastFailureTime;
        if (elapsed >= this.resetTimeoutMs) {
          this.state = CircuitState.HALF_OPEN;
          this.probeInFlight = false;
          return this.claimProbe();
        }
        return false;
      }
      case CircuitState.HALF_OPEN:
        return this.claimProbe();
      default:
        return true;
    }
  }

  /** Claim the single probe slot. Returns false if already taken. */
  private claimProbe(): boolean {
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  /**
   * Record a successful operation – resets the circuit to CLOSED.
   */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.probeInFlight = false;
    this.state = CircuitState.CLOSED;
  }

  /**
   * Record a failed operation – may trip the circuit to OPEN.
   */
  recordFailure(): void {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();
    this.probeInFlight = false;

    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = CircuitState.OPEN;
    }
  }

  /**
   * Manually reset the circuit (e.g. when user retries or config changes).
   */
  reset(): void {
    this.state = CircuitState.CLOSED;
    this.consecutiveFailures = 0;
    this.lastFailureTime = 0;
    this.probeInFlight = false;
  }

  /**
   * Read the current state without side effects.
   * OPEN → HALF_OPEN transition only happens in canAttempt().
   */
  getState(): CircuitState {
    if (this.state === CircuitState.OPEN) {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.resetTimeoutMs) {
        return CircuitState.HALF_OPEN;
      }
    }
    return this.state;
  }

  getName(): string {
    return this.name;
  }

  getRemainingCooldownMs(): number {
    if (this.state !== CircuitState.OPEN) {
      return 0;
    }
    const elapsed = Date.now() - this.lastFailureTime;
    return Math.max(0, this.resetTimeoutMs - elapsed);
  }
}
