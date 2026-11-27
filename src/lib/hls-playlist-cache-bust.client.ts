/**
 * 播放列表缓存穿透（cache-busting）hls.js loader。
 *
 * 背景：部分资源站 CDN 的缓存键包含 URL 查询串，且边缘节点会短暂保留
 * 转码未完成时的截断 m3u8（时长缩水、后半集无法播放）。对同一 URL 反复
 * 重载只会反复命中同一个坏缓存桶；给每次播放列表请求（manifest/level）
 * 追加一次性随机参数，相当于每次采样一个新的缓存桶，能显著提高坏缓存
 * 窗口内拿到完整列表的概率。
 *
 * 只改写播放列表请求；分片（fragment）内容不可变，保持原 URL 继续吃缓存。
 * 签名类 URL（网盘挂载等，query 带 sign/token/key 等）不改写，避免破坏签名。
 */

/** 常见签名参数名：命中任何一个都视为签名链接，禁止改写 */
const SIGNED_QUERY_PARAM_RE =
  /[?&](sign|token|key|hmac|auth|wssecret|wstime|ossexpires|x-oss-process)=/i;

/** 本 loader 追加的穿透参数名（重复请求会替换旧值，不会无限追加） */
export const CACHE_BUST_PARAM = '_mpcb';

/**
 * 判断该播放列表 URL 是否可以安全加穿透参数：
 * 仅 http(s) 直链且 query 不含签名参数。
 */
export function shouldBustPlaylistCache(url: string): boolean {
  if (!url || !/^https?:/i.test(url)) {
    return false;
  }
  return !SIGNED_QUERY_PARAM_RE.test(url);
}

/**
 * 给 URL 追加（或替换）穿透参数。
 */
export function appendCacheBuster(url: string, bustValue: string): string {
  if (!bustValue) {
    return url;
  }
  // 替换旧的穿透参数，避免多次重载后参数无限变长
  const replaceRe = new RegExp(`([?&])${CACHE_BUST_PARAM}=[^&]*`);
  if (replaceRe.test(url)) {
    return url.replace(replaceRe, `$1${CACHE_BUST_PARAM}=${bustValue}`);
  }
  return `${url}${url.includes('?') ? '&' : '?'}${CACHE_BUST_PARAM}=${bustValue}`;
}

/**
 * 生成一次性穿透参数值：每次请求都不同，确保采样不同缓存桶。
 */
export function makeCacheBustValue(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 生成缓存穿透 loader 类。在现有 loader（默认 loader 或去广告 loader）之上
 * 套一层：拦截 manifest / level 请求改写 URL，其余请求原样放行。
 * 用工厂 + 传入基类的方式与去广告 loader 自由组合。
 */
export function createCacheBustingPlaylistLoader(
  baseLoaderClass: any,
  getBustValue: () => string = makeCacheBustValue
): any {
  return class CacheBustingPlaylistLoader extends baseLoaderClass {
    constructor(config: any) {
      super(config);
      const load = this.load.bind(this);
      this.load = function (context: any, config: any, callbacks: any) {
        if (
          (context?.type === 'manifest' || context?.type === 'level') &&
          typeof context?.url === 'string' &&
          shouldBustPlaylistCache(context.url)
        ) {
          const bustValue = getBustValue();
          if (bustValue) {
            context.url = appendCacheBuster(context.url, bustValue);
          }
        }
        load(context, config, callbacks);
      };
    }
  };
}
