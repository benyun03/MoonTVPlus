import {
  CACHE_BUST_PARAM,
  appendCacheBuster,
  createCacheBustingPlaylistLoader,
  makeCacheBustValue,
  shouldBustPlaylistCache,
} from '@/lib/hls-playlist-cache-bust.client';

describe('shouldBustPlaylistCache', () => {
  it('普通 http(s) m3u8 直链允许穿透', () => {
    expect(
      shouldBustPlaylistCache('https://cdn.example.com/20221031/abc/index.m3u8')
    ).toBe(true);
    expect(
      shouldBustPlaylistCache(
        'https://cdn.example.com/2000kb/hls/index.m3u8?width=1280'
      )
    ).toBe(true);
  });

  it('签名链接不改写（网盘挂载等）', () => {
    const signed = [
      'https://openlist.example.com/d/video.m3u8?sign=v1:abc',
      'https://cdn.example.com/hls/index.m3u8?token=xyz',
      'https://cdn.example.com/hls/index.m3u8?wsSecret=abc&wsTime=123',
      'https://oss.example.com/hls/index.m3u8?key=secret',
      'https://cdn.example.com/hls/index.m3u8?hmac=deadbeef',
    ];
    signed.forEach((u) => expect(shouldBustPlaylistCache(u)).toBe(false));
  });

  it('非 http(s) 与空串不改写（blob:、代理相对路径等）', () => {
    expect(shouldBustPlaylistCache('blob:https://x/y')).toBe(false);
    expect(shouldBustPlaylistCache('')).toBe(false);
    expect(shouldBustPlaylistCache('/api/proxy-m3u8?x=1')).toBe(false);
  });
});

describe('appendCacheBuster', () => {
  it('无查询串时追加 ?，有查询串时追加 &', () => {
    expect(appendCacheBuster('https://x/a.m3u8', 'abc')).toBe(
      'https://x/a.m3u8?_mpcb=abc'
    );
    expect(appendCacheBuster('https://x/a.m3u8?w=1', 'abc')).toBe(
      'https://x/a.m3u8?w=1&_mpcb=abc'
    );
  });

  it('已有穿透参数时替换旧值，不无限追加', () => {
    const once = appendCacheBuster('https://x/a.m3u8', 'v1');
    const twice = appendCacheBuster(once, 'v2');
    expect(twice).toBe('https://x/a.m3u8?_mpcb=v2');
    expect(twice.match(new RegExp(CACHE_BUST_PARAM, 'g'))).toHaveLength(1);
  });

  it('空穿透值原样返回', () => {
    expect(appendCacheBuster('https://x/a.m3u8', '')).toBe('https://x/a.m3u8');
  });
});

describe('makeCacheBustValue', () => {
  it('每次生成不同的一次性值', () => {
    const values = new Set(Array.from({ length: 20 }, () => makeCacheBustValue()));
    expect(values.size).toBe(20);
  });
});

describe('createCacheBustingPlaylistLoader', () => {
  function makeFakeHlsLoader() {
    return class FakeLoader {
      loadCalls: Array<{ context: any; config: any; callbacks: any }> = [];
      load(context: any, config: any, callbacks: any) {
        this.loadCalls.push({ context, config, callbacks });
      }
    };
  }

  it('manifest/level 请求被改写，其它请求原样放行', () => {
    const Base = makeFakeHlsLoader();
    const Wrapper = createCacheBustingPlaylistLoader(Base);
    const loader = new Wrapper({} as any);

    const manifestCtx = { type: 'manifest', url: 'https://x/index.m3u8' };
    const levelCtx = { type: 'level', url: 'https://x/2000kb/hls/index.m3u8' };
    const fragCtx = { type: 'fragment', url: 'https://x/seg-1.ts' };
    loader.load(manifestCtx, {}, {});
    loader.load(levelCtx, {}, {});
    loader.load(fragCtx, {}, {});

    expect(manifestCtx.url).toContain('index.m3u8?_mpcb=');
    expect(levelCtx.url).toContain('index.m3u8?_mpcb=');
    expect(fragCtx.url).toBe('https://x/seg-1.ts');
    expect(loader.loadCalls).toHaveLength(3);
  });

  it('签名 URL 不改写', () => {
    const Base = makeFakeHlsLoader();
    const Wrapper = createCacheBustingPlaylistLoader(Base);
    const loader = new Wrapper({} as any);
    const ctx = { type: 'level', url: 'https://x/index.m3u8?sign=v1:abc' };
    loader.load(ctx, {}, {});
    expect(ctx.url).toBe('https://x/index.m3u8?sign=v1:abc');
  });

  it('自定义 getBustValue 生效', () => {
    const Base = makeFakeHlsLoader();
    const Wrapper = createCacheBustingPlaylistLoader(Base, () => 'fixed');
    const loader = new Wrapper({} as any);
    const ctx = { type: 'manifest', url: 'https://x/index.m3u8' };
    loader.load(ctx, {}, {});
    expect(ctx.url).toBe('https://x/index.m3u8?_mpcb=fixed');
  });
});
