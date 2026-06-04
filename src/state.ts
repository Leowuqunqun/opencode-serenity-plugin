/**
 * 全局激活状态 — v0.1 两阶段 init 支持
 *
 * 状态机（ReadyStateMachine）：
 *   idle → loading → ready / error / disabled
 *
 * 维持旧 API 兼容：
 *   - getState() / setState() / isActive() / resetState() 不变
 *
 * 新增 v0.1 API：
 *   - getReadyMachine()   拿状态机
 *   - ensureReady()       tools/hooks execute 阻塞等待激活完成
 *
 * 注意：plugin 入口的 input 是 opencode 调用时传入的，Hooks 闭包要访问状态
 * —— 用模块级 singleton 缓存。
 */

import { INACTIVE_STATE, type SerenityState } from './types/index.js';
import { ReadyStateMachine } from './util/ready-state.js';

let _state: SerenityState = INACTIVE_STATE;
const _machine = new ReadyStateMachine();

/** 写入激活状态（仅 activation.ts 调用） */
export function setState(state: SerenityState): void {
  _state = state;
  if (state.activated) {
    // 立即把状态机推到 ready（v0 路径：同步激活完成）
    // 注：setState 自身不暴露 machine API；activation.ts 走的是 markReady 显式调用
  }
}

/** 读取当前激活状态（其他模块用） */
export function getState(): SerenityState {
  return _state;
}

/** 是否已激活（最常用判定，**同步快路径**） */
export function isActive(): boolean {
  return _state.activated;
}

/** 重置为不激活（测试用） */
export function resetState(): void {
  _state = INACTIVE_STATE;
  _machine.reset();
}

/** v0.1：拿状态机（activation.ts / hooks 内部用） */
export function getReadyMachine(): ReadyStateMachine {
  return _machine;
}

/** v0.1：tools/hooks execute 阻塞等待激活完成 */
export async function ensureReady(): Promise<void> {
  // 快路径：v0 同步激活完成，state.activated === true
  if (_state.activated) return;
  // 慢路径：v0.1 异步激活，阻塞等待状态机
  await _machine.whenReady();
}

/** v0.1：把状态机推 ready（activation.ts 异步完成时调） */
export function markReady(): void {
  _machine.markAsReady();
}

/** v0.1：把状态机推 disabled（sync 阶段失败时调） */
export function markDisabled(reason: string): void {
  _machine.markDisabled(reason);
}
