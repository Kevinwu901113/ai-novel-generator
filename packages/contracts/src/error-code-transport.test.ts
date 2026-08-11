/**
 * IPC 错误码传输编码测试。
 *
 * 背景：Electron 的 ipcMain.handle 只把 handler 抛出错误的 `error.toString()`
 * 回传给 renderer——自定义 `.code` 属性在 preload 侧就已丢失。main 侧改为把
 * code 编进 message 文本传输，renderer 侧解码。这里覆盖编码格式本身的
 * 单一事实源（main 与 renderer 共用），保证两侧不会各自维护字面量而漂移。
 */

import { describe, it, expect } from 'vitest';
import { encodeErrorCode, decodeErrorCode, stripErrorCode } from './index';

describe('encodeErrorCode', () => {
  it('把 code 以 [CODE:xxx] 前缀编入 message', () => {
    expect(encodeErrorCode('GRAPH_RUN_STATE_CONFLICT', '状态冲突')).toBe(
      '[CODE:GRAPH_RUN_STATE_CONFLICT] 状态冲突',
    );
  });
});

describe('decodeErrorCode', () => {
  it('从纯编码 message 中解码出 code', () => {
    expect(decodeErrorCode('[CODE:GRAPH_RUN_STATE_CONFLICT] 状态冲突')).toBe(
      'GRAPH_RUN_STATE_CONFLICT',
    );
  });

  it('从 Electron 包裹格式的 message 中段解码出 code', () => {
    // Electron ipcMain.handle 抛出错误后，preload/renderer 侧拿到的重建 Error
    // message 形如：Error invoking remote method '<channel>': Error: <原 message>
    const wrapped =
      "Error invoking remote method 'ipc:graph-apply-human-decision': " +
      'Error: [CODE:GRAPH_RUN_STATE_CONFLICT] Graph run abc-123 状态冲突';
    expect(decodeErrorCode(wrapped)).toBe('GRAPH_RUN_STATE_CONFLICT');
  });

  it('message 内嵌 UUID 也不影响 code 解码', () => {
    const wrapped =
      "Error invoking remote method 'ipc:graph-apply-human-decision': " +
      'Error: [CODE:GRAPH_RUN_VERSION_CONFLICT] Graph run 550e8400-e29b-41d4-a716-446655440000 版本冲突，请刷新后重试';
    expect(decodeErrorCode(wrapped)).toBe('GRAPH_RUN_VERSION_CONFLICT');
  });

  it('无编码段的 message 返回 null', () => {
    expect(decodeErrorCode('普通错误消息，没有编码段')).toBeNull();
  });

  it('空字符串返回 null', () => {
    expect(decodeErrorCode('')).toBeNull();
  });

  it('编码段格式非法（含小写字母）时不解码', () => {
    expect(decodeErrorCode('[CODE:graph_run_state_conflict] 状态冲突')).toBeNull();
  });
});

describe('stripErrorCode', () => {
  it('剥离编码段，保留其余文本并 trim', () => {
    expect(stripErrorCode('[CODE:GRAPH_RUN_STATE_CONFLICT] 状态冲突')).toBe('状态冲突');
  });

  it('剥离 Electron 包裹格式中段的编码段', () => {
    const wrapped = "Error invoking remote method 'ipc:xxx': Error: [CODE:UNKNOWN_CODE] 出错了";
    const stripped = stripErrorCode(wrapped);
    expect(stripped).not.toContain('[CODE:');
    expect(stripped).not.toContain('UNKNOWN_CODE');
  });

  it('无编码段时原样返回（仅 trim）', () => {
    expect(stripErrorCode('  普通消息  ')).toBe('普通消息');
  });
});

describe('encodeErrorCode/decodeErrorCode 往返一致', () => {
  it('encode 后 decode 能拿回同一个 code', () => {
    const encoded = encodeErrorCode('CONTRACT_VERSION_CONFLICT', '契约版本冲突');
    expect(decodeErrorCode(encoded)).toBe('CONTRACT_VERSION_CONFLICT');
  });
});
