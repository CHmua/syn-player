// ============================================================
//  TMDB API Proxy — Cloudflare Worker
//  部署后把 worker URL 填入 .env 的 TMDB_PROXY
// ============================================================
//  部署步骤:
//  1. 打开 https://workers.cloudflare.com → 注册/登录
//  2. 点击 "Create a Worker"
//  3. 把这段代码粘贴进去，点击 "Deploy"
//  4. 复制你的 worker URL (如 https://tmdb-proxy.xxx.workers.dev)
//  5. 在 .env 设置: TMDB_PROXY=https://你的worker地址
//
//  免费额度: 每天10万次请求，完全够用
// ============================================================

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const tmdbPath = url.pathname + url.search;
    const tmdbUrl = 'https://api.themoviedb.org/3' + tmdbPath;

    const response = await fetch(tmdbUrl, {
      method: request.method,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'SynPlayer/1.0'
      }
    });

    const headers = new Headers();
    headers.set('Content-Type', 'application/json');
    headers.set('Access-Control-Allow-Origin', '*');

    return new Response(response.body, {
      status: response.status,
      headers
    });
  }
};
