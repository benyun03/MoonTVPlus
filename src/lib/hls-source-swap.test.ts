import {
  TruncatedSourceRollbackError,
  decideSourceSwapByDuration,
  isDurationConsistentWithKnownTotal,
  isTruncatedSourceRollbackError,
  readHlsLevelTotalDuration,
} from '@/lib/hls-source-swap';

describe('decideSourceSwapByDuration', () => {
  const T24MIN = 24 * 60 + 7; // 24 分多
  const T14MIN = 14 * 60 + 1; // 14 分钟

  it('接受时长一致的续期链接', () => {
    const d = decideSourceSwapByDuration(T24MIN, T24MIN + 0.5);
    expect(d.accept).toBe(true);
    expect(d.reason).toBe('duration_ok');
  });

  it('接受时长在容差内的链接（绝对 5s 或 2% 取大）', () => {
    // 4s：小于绝对容差 5s
    expect(decideSourceSwapByDuration(T24MIN, T24MIN - 4).accept).toBe(true);
    // 25s：小于 2% 容差（约 28.9s）
    expect(decideSourceSwapByDuration(T24MIN, T24MIN - 25).accept).toBe(true);
    // 略长也接受
    expect(decideSourceSwapByDuration(T24MIN, T24MIN + 30).accept).toBe(true);
  });

  it('拒绝明显截断的链接（24 分钟 -> 14 分钟）', () => {
    // 回归用例：链接续期换到内容更短的流，导致时长中途缩水、后半集无法播放
    const d = decideSourceSwapByDuration(T24MIN, T14MIN);
    expect(d.accept).toBe(false);
    expect(d.reason).toContain('new_source_truncated');
  });

  it('拒绝超过容差的截断（丢失 30s 以上）', () => {
    expect(decideSourceSwapByDuration(T24MIN, T24MIN - 30).accept).toBe(false);
  });

  it('新时长未知时放行（fail-open）', () => {
    expect(decideSourceSwapByDuration(T24MIN, null).reason).toBe(
      'new_duration_unknown'
    );
    expect(decideSourceSwapByDuration(T24MIN, NaN).accept).toBe(true);
    expect(decideSourceSwapByDuration(T24MIN, 0).accept).toBe(true);
    expect(
      decideSourceSwapByDuration(T24MIN, undefined as unknown as number).accept
    ).toBe(true);
  });

  it('旧时长未知（live 流 Infinity / 0）时放行（fail-open）', () => {
    expect(decideSourceSwapByDuration(Infinity, T14MIN).reason).toBe(
      'old_duration_unknown'
    );
    expect(decideSourceSwapByDuration(0, T14MIN).accept).toBe(true);
    expect(decideSourceSwapByDuration(NaN, T14MIN).accept).toBe(true);
  });
});

describe('readHlsLevelTotalDuration', () => {
  it('读取当前 level 的 totalduration', () => {
    const hls = {
      currentLevel: 1,
      levels: [
        { details: { totalduration: 100 } },
        { details: { totalduration: 857 } },
      ],
    };
    expect(readHlsLevelTotalDuration(hls)).toBe(857);
  });

  it('无 currentLevel 时回退到第一个 level', () => {
    const hls = { levels: [{ details: { totalduration: 1456 } }] };
    expect(readHlsLevelTotalDuration(hls)).toBe(1456);
    expect(
      readHlsLevelTotalDuration({ currentLevel: -1, levels: hls.levels })
    ).toBe(1456);
  });

  it('levels/details 缺失或非法时返回 null', () => {
    expect(readHlsLevelTotalDuration(null)).toBeNull();
    expect(readHlsLevelTotalDuration({})).toBeNull();
    expect(readHlsLevelTotalDuration({ levels: [] })).toBeNull();
    expect(
      readHlsLevelTotalDuration({ levels: [{ details: { totalduration: 0 } }] })
    ).toBeNull();
    expect(readHlsLevelTotalDuration({ levels: [{ details: {} }] })).toBeNull();
  });
});

describe('isDurationConsistentWithKnownTotal', () => {
  const T24MIN = 24 * 60 + 7;
  const T14MIN = 14 * 60 + 1;

  it('无已知总时长时不表态（视为一致）', () => {
    expect(isDurationConsistentWithKnownTotal(0, T14MIN)).toBe(true);
    expect(isDurationConsistentWithKnownTotal(NaN, T14MIN)).toBe(true);
    expect(isDurationConsistentWithKnownTotal(Infinity, T14MIN)).toBe(true);
  });

  it('实际时长未知时不表态（视为一致）', () => {
    expect(isDurationConsistentWithKnownTotal(T24MIN, 0)).toBe(true);
    expect(isDurationConsistentWithKnownTotal(T24MIN, NaN)).toBe(true);
  });

  it('发现截断源：24 分钟内容只剩 14 分钟', () => {
    // 回归用例：从播放记录续播进入时解析到截断 m3u8，续播点会被钳到片尾
    expect(isDurationConsistentWithKnownTotal(T24MIN, T14MIN)).toBe(false);
    expect(isDurationConsistentWithKnownTotal(T24MIN, T24MIN - 30)).toBe(
      false
    );
  });

  it('时长一致或更长时视为一致', () => {
    expect(isDurationConsistentWithKnownTotal(T24MIN, T24MIN)).toBe(true);
    expect(isDurationConsistentWithKnownTotal(T24MIN, T24MIN + 30)).toBe(true);
    expect(isDurationConsistentWithKnownTotal(T24MIN, T24MIN - 25)).toBe(true);
  });
});

describe('TruncatedSourceRollbackError', () => {
  it('携带标记 name，便于与刷新失败区分', () => {
    const err = new TruncatedSourceRollbackError(
      'new_source_truncated: 857.0s < 1447.0s'
    );
    expect(err.name).toBe('TruncatedSourceRollbackError');
    expect(err.message).toContain('已回滚原链接');
    expect(isTruncatedSourceRollbackError(err)).toBe(true);
  });

  it('普通错误与异步 reject 的普通 Error 不算回滚', () => {
    expect(isTruncatedSourceRollbackError(new Error('加载超时'))).toBe(false);
    expect(isTruncatedSourceRollbackError(null)).toBe(false);
    expect(isTruncatedSourceRollbackError('x')).toBe(false);
  });
});
