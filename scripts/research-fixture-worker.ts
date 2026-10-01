/** Public, synthetic data only. Used by the company-research provider canary. */
const researchFixtureWorker = {
  fetch(request: Request) {
    const url = new URL(request.url);
    const blocked = url.hostname.includes("research-blocked-fixture");
    if (url.pathname === "/robots.txt") {
      return new Response(
        `User-agent: *\nAllow: /\nDisallow: /excluded\nContent-Signal: search=yes, ai-input=yes, ai-train=${blocked ? "no" : "yes"}\n`,
        { headers: { "Content-Type": "text/plain; charset=utf-8" } },
      );
    }
    if (url.pathname === "/redirect-private") {
      return Response.redirect("http://127.0.0.1:9/", 302);
    }
    if (url.pathname === "/redirect-external") {
      return Response.redirect("https://example.com/", 302);
    }
    if (url.pathname === "/redirect-private-dns") {
      return Response.redirect("http://127.0.0.1.nip.io/", 302);
    }
    if (url.pathname === "/pagination") {
      return new Response(`<html><body><h1>Pagination fixture</h1>${Array.from({ length: 12 }, (_, i) => `<a href='/page/${i + 1}'>Page ${i + 1}</a>`).join("")}</body></html>`, { headers: { "Content-Type": "text/html" } });
    }
    if (/^\/page\/(?:[1-9]|1[0-2])$/.test(url.pathname)) {
      return new Response(`<html><body><h1>Service documentation ${url.pathname}</h1><p>Synthetic public service information.</p></body></html>`, { headers: { "Content-Type": "text/html" } });
    }
    const pages: Record<string, string> = {
      "/": "<h1>Alpha Studio</h1><p>Alpha Studioは企業向けにWebサイト制作と映像制作を提供します。</p><a href='/services'>サービス</a><a href='/cases'>制作実績</a><a href='/excluded'>取得禁止ページ</a>",
      "/services": "<h1>サービス</h1><p>Webサイト制作では企業サイトの企画、デザイン、実装に対応します。</p><p>映像制作ではプロモーション動画の企画、撮影、編集に対応します。</p><p>対応地域は東京と横浜です。</p><p>撮影のみの依頼には対応していません。</p>",
      "/cases": "<h1>制作実績</h1><p>企業サイトと企業紹介動画を同時に制作するワンストップサービスを提供しています。</p>",
      "/excluded": "<h1>Excluded fixture</h1><p>ROBOTS_BLOCKED_CONTENT_MUST_NOT_BE_EXTRACTED</p>",
    };
    const page = pages[url.pathname];
    return new Response(
      page ? `<!doctype html><html lang='ja'><head><meta charset='utf-8'><title>Alpha Studio</title></head><body><main>${page}</main></body></html>` : "Not found",
      { status: page ? 200 : 404, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  },
};

export default researchFixtureWorker;
