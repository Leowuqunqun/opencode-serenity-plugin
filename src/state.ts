/**
 * 全局激活状态 — 在 plugin 内部维护 in-memory cache
 *
 * 设计：plugin 入口的 input 是 opencode 调用时传入的，但 Hooks 闭包要访问状态
 * —— 用模块级 singleton 缓存
 */

import { INACTIVE_STATE, type SerenityState } from './types/index.js';

let _state: SerenityState = INACTIVE_STATE;

/** 写入激活状态（仅 activation.ts 调用） */
export function setState(state: SerenityState): void {
  _state = state;
}

/** 读取当前激活状态（其他模块用） */
export function getState(): SerenityState {
  return _state;
}

/** 是否已激活（最常用判定） */
export function isActive(): boolean {
  return _state.activated;
}

/** 重置为不激活（测试用） */
export function resetState(): void {
  _state = INACTIVE_STATE;
}
