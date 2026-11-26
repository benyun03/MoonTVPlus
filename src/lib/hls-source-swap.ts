/**
 * HLS 静默换源（14 分钟链接续期 / 403 错误刷新）时的时长一致性校验。
 *
 * 背景：续期只应更换签名地址，不应更换内容。但部分网盘挂载源（OpenList/Alist
 * 预览流转码等）重新解析出的 m3u8 可能只包含部分时长（如 24 分钟只剩 14 分钟）。
 * 换源前不校验会导致播放器时长中途缩水、后半集无法播放。
 */

export interface SourceSwapDurationDecision {
  /** 是否允许换到新链接 */
  accept: boolean;
  /** 决策原因（用于日志） */
  reason: string;
}

/**
 * 续期换源时长校验未通过、已回滚原链接时抛出的标记错误。
 * 调用方据此与「刷新真的失败」区分开：回滚成功意味着旧链接仍可播，
 * 不应走销毁播放器/快速重试的失败路径。
 */
export class TruncatedSourceRollbackError extends Error {
  constructor(reason: string) {
    super(`刷新后的链接疑似内容截断(${reason})，已回滚原链接`);
    this.name = 'TruncatedSourceRollbackError';
  }
}

export function isTruncatedSourceRollbackError(
  error: unknown
): error is TruncatedSourceRollbackError {
  return (
    error instanceof Error &&
    (error instanceof TruncatedSourceRollbackError ||
      error.name === 'TruncatedSourceRollbackError')
  );
}

/**
 * 首次加载（如从播放记录续播进入）时的时长一致性判断：
 * 已知该剧集此前的总时长，而本次解析出的流明显更短，说明拿到的是
 * 截断源（转码未完成/预览流只有部分内容），续播位置会被钳到片尾。
 * 无已知总时长（首次观看、记录缺失）时不表态。
 */
export function isDurationConsistentWithKnownTotal(
  knownTotal: number,
  actualDuration: number
): boolean {
  if (!Number.isFinite(knownTotal) || knownTotal <= 0) {
    return true;
  }
  if (!Number.isFinite(actualDuration) || actualDuration <= 0) {
    return true;
  }
  return decideSourceSwapByDuration(knownTotal, actualDuration).accept;
}

/**
 * 依据新旧时长判断是否接受换源。
 * - 任一侧时长未知（live 流为 Infinity、信息缺失等）时放行，避免误伤正常续期。
 * - 新时长在容差内（绝对 5s 或旧时长的 2%，取大者）视为同一内容。
 */
export function decideSourceSwapByDuration(
  oldDuration: number,
  newDuration: number | null | undefined
): SourceSwapDurationDecision {
  if (!Number.isFinite(oldDuration) || oldDuration <= 0) {
    return { accept: true, reason: 'old_duration_unknown' };
  }
  if (
    newDuration == null ||
    !Number.isFinite(newDuration) ||
    newDuration <= 0
  ) {
    return { accept: true, reason: 'new_duration_unknown' };
  }
  const tolerance = Math.max(5, oldDuration * 0.02);
  if (newDuration >= oldDuration - tolerance) {
    return { accept: true, reason: 'duration_ok' };
  }
  return {
    accept: false,
    reason: `new_source_truncated: ${newDuration.toFixed(
      1
    )}s < ${oldDuration.toFixed(1)}s - tolerance ${tolerance.toFixed(1)}s`,
  };
}

/**
 * 从 hls.js 实例读取当前 level 的 playlist 总时长（秒）。
 * 直连媒体播放列表在 MANIFEST_PARSED 时即可读取；master 播放列表需等
 * LEVEL_LOADED，读取不到时返回 null（由调用方决定是否等待）。
 */
export function readHlsLevelTotalDuration(
  hls:
    | {
        levels?: Array<{ details?: { totalduration?: number } }>;
        currentLevel?: number;
      }
    | null
    | undefined
): number | null {
  const levels = hls?.levels;
  if (!Array.isArray(levels) || levels.length === 0) {
    return null;
  }
  const current =
    typeof hls?.currentLevel === 'number' && hls.currentLevel >= 0
      ? levels[hls.currentLevel]
      : null;
  const duration =
    current?.details?.totalduration ?? levels[0]?.details?.totalduration;
  return typeof duration === 'number' &&
    Number.isFinite(duration) &&
    duration > 0
    ? duration
    : null;
}
