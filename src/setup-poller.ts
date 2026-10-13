export interface SetupCheck {
  ok: boolean;
  status: "CONFIGURED" | "ALREADY_CONFIGURED" | "PENDING_APPROVAL" | "EXPIRED" | "NO_PENDING_SETUP" | "RETRY" | "FAILED";
  message: string;
  pollIntervalSeconds?: number;
  client_type?: string;
  host_label?: string;
}

export function setupPollDelay(seconds: number | undefined): number {
  return Number.isFinite(seconds) && seconds! > 0 ? Math.ceil(seconds! * 1000) : 2000;
}

// 手动完成与后台轮询共用一次在途请求，避免重复领取/写入凭证。
export class SetupPoller {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<SetupCheck> | undefined;
  private running = false;
  private generation = 0;

  constructor(private readonly check: () => Promise<SetupCheck>, private readonly expiresAt?: () => number | undefined) {}

  pollOnce(): Promise<SetupCheck> {
    if (!this.inFlight) {
      this.inFlight = Promise.resolve().then(this.check).finally(() => { this.inFlight = undefined; });
    }
    return this.inFlight;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0, ++this.generation);
  }

  stop(): void {
    this.running = false;
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(delay: number, generation: number): void {
    const deadline = this.expiresAt?.();
    if (deadline !== undefined && Number.isFinite(deadline)) delay = Math.min(delay, Math.max(0, deadline - Date.now()));
    delay = Math.min(delay, 2_147_483_647);
    this.timer = setTimeout(() => { void this.tick(generation); }, delay);
    this.timer.unref();
  }

  private async tick(generation: number): Promise<void> {
    let result: SetupCheck;
    try {
      result = await this.pollOnce();
    } catch {
      result = { ok: false, status: "RETRY", message: "Unable to finish setup yet." };
    }
    if (!this.running || generation !== this.generation) return;
    if (result.status === "PENDING_APPROVAL" || result.status === "RETRY") {
      const delay = setupPollDelay(result.pollIntervalSeconds);
      this.schedule(result.status === "RETRY" ? Math.max(delay, 5000) : delay, generation);
    } else {
      this.stop();
    }
  }
}
