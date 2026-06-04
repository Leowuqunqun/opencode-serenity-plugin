/**
 * ReadyStateMachine — 两阶段 init 的状态机
 *
 * 参考 skillful 的 ReadyStateMachine.ts（91 行）。
 *
 * 阶段 1（同步）：plugin 入口立即返回 hooks；tools 立即可调用
 * 阶段 2（异步）：后台做 IO 验证（RR1+RR2）；验证完成前 tool execute 阻塞等待
 *
 * 状态流转：
 *   idle → loading → ready     (成功)
 *                  → error     (IO 失败)
 *                  → disabled  (条件不满足)
 *
 * 一次性 Promise：`whenReady()` 多次调用返回同一 Promise（不重复创建）。
 */

export type State = "idle" | "loading" | "ready" | "error" | "disabled";

export class ReadyStateMachine {
  private current: State = "idle";
  private promise: Promise<void> | null = null;
  private resolveFn: (() => void) | null = null;
  private rejectFn: ((err: Error) => void) | null = null;
  private errorValue: Error | null = null;

  /** 当前状态（同步读）*/
  get state(): State {
    return this.current;
  }

  /** 状态对应的 reason（error/disabled 时）*/
  get reason(): Error | null {
    return this.errorValue;
  }

  /**
   * 启动后台验证。
   * 多次调用安全：只有第一次会真正启动（之后的调用复用同一 Promise）。
   */
  start(loader: () => Promise<void>): Promise<void> {
    if (this.current === "loading") {
      return this.promise!;
    }
    if (this.current !== "idle") {
      // 已 settled，直接 resolve 或 reject
      return this.current === "ready"
        ? Promise.resolve()
        : Promise.reject(this.errorValue ?? new Error("unknown"));
    }

    this.current = "loading";
    this.promise = new Promise<void>((resolve, reject) => {
      this.resolveFn = resolve;
      this.rejectFn = reject;
    });

    loader()
      .then(() => {
        this.current = "ready";
        this.resolveFn?.();
      })
      .catch((err: unknown) => {
        this.current = "error";
        this.errorValue =
          err instanceof Error ? err : new Error(String(err));
        this.rejectFn?.(this.errorValue);
      });

    return this.promise;
  }

  /** 工具执行前的阻塞等待 */
  whenReady(): Promise<void> {
    if (this.current === "ready") {
      return Promise.resolve();
    }
    if (this.current === "error" || this.current === "disabled") {
      return Promise.reject(
        this.errorValue ?? new Error(`Serenity not active: ${this.current}`),
      );
    }
    if (this.current === "loading" && this.promise) {
      return this.promise;
    }
    // idle（未 start）— 视为 disabled
    return Promise.reject(
      new Error("Serenity plugin not initialized: state=idle"),
    );
  }

  /** 同步状态查询（不阻塞） */
  isReady(): boolean {
    return this.current === "ready";
  }

  /** 强制标记 disabled（不依赖 loader 完成；用于 plugin 入口短路 RR6 失败场景） */
  markDisabled(reason: string): void {
    if (this.current !== "idle") return; // 已 settled 不变
    this.current = "disabled";
    this.errorValue = new Error(reason);
    // 不会 resolve 任何 promise（p1 用户可能永远不调用 whenReady）
  }

  /** 外部显式标记 ready（v0 同步激活完成后用；保留 start() 的 Promise 兼容性） */
  markAsReady(): void {
    if (this.current !== "loading" && this.current !== "idle") return;
    this.current = "ready";
    this.resolveFn?.();
  }

  /** 重置（仅测试用） */
  reset(): void {
    this.current = "idle";
    this.promise = null;
    this.resolveFn = null;
    this.rejectFn = null;
    this.errorValue = null;
  }
}
