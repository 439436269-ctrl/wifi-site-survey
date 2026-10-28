// 吞吐测量：N 路并发 Range 下载，统计 socket 上真实收到的字节数 ÷ 真实耗时。
//
// 为什么不用 curl 自报速率相加：每个 curl 报的是自己的平均速率，
// 各任务启动时间差 1–3 秒，相加会把峰值当整体（实测 1625 vs 真实 889）。
import https from 'node:https';
import http from 'node:http';

/**
 * @param {string} url      下载地址（需支持 Range）
 * @param {object} opts
 * @param {number} opts.threads  并发数
 * @param {number} opts.seconds  时长
 * @param {string} opts.userAgent 必须带：TUNA 会对空 UA / 浏览器 UA 返回 403
 * @returns {Promise<{mbps:number, bytes:number, seconds:number, statuses:number[]}>}
 */
export function measureThroughput(url, { threads = 8, seconds = 6, userAgent = 'wifi-test/1.0' } = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const port = u.port || (u.protocol === 'https:' ? 443 : 80);
    const t0 = Date.now();
    const statuses = [];
    let bytes = 0;
    let settled = false;
    const reqs = [];

    const finish = () => {
      if (settled) return;
      settled = true;
      const secs = (Date.now() - t0) / 1000;
      for (const r of reqs) { try { r.destroy(); } catch {} }
      resolve({ mbps: (bytes * 8) / secs / 1e6, bytes, seconds: secs, statuses });
    };

    for (let i = 0; i < threads; i++) {
      const req = lib.get(
        {
          hostname: u.hostname,
          path: `${u.pathname}${u.search || ''}`,
          port,
          headers: {
            Range: `bytes=${i * 100000000}-`,
            'User-Agent': userAgent,
            Accept: '*/*',
          },
          rejectUnauthorized: false,
        },
        (res) => {
          statuses.push(res.statusCode);
          res.on('data', (c) => { bytes += c.length; });
          res.on('error', () => {});
          res.on('end', () => {});
        }
      );
      req.on('error', () => {});
      req.setTimeout(15000, () => { try { req.destroy(); } catch {} });
      reqs.push(req);
    }

    setTimeout(finish, seconds * 1000 + 500);
  });
}
