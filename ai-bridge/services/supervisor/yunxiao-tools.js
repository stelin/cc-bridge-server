/**
 * Yunxiao (Alibaba Cloud DevOps / 云效) bug-detail tool for the supervisor + main-AI MCP servers.
 *
 * `query_bug_details` aggregates a 云效 工作项's 基础信息 + 所有评论 + 附件 AND downloads
 * every embedded image (and every attachment) to a local tmp dir, returning the
 * local paths so the AI can `Read` them (Read on an image = Claude vision). 云效
 * embeds images behind a login-cookie web-console proxy
 * (devops.aliyun.com/.../file/url?fileIdentifier=...) the AI can't fetch directly,
 * so we resolve each fileIdentifier through the OpenAPI GetWorkitemFile endpoint
 * (token auth) to a fresh signed OSS url and download that.
 *
 * Images are always downloaded; non-image attachments are downloaded too but only
 * surfaced as paths (the AI Reads text-type files on demand). Downloads land in the
 * DAEMON's tmp (os.tmpdir()/yunxiao-bugs/<bugId>/): local mode = the user's machine,
 * remote mode = the ai-bridge-server — the same machine the AI's Read tool runs on,
 * so Read always sees them. Left for the OS to clean. Limits: ≤8MB/file, ≤20 files,
 * ≤50MB total per call.
 *
 * Mounted on both the `supervisor` and `main` MCP servers. Credentials come from the
 * daemon env (process.env.YUNXIAO_TOKEN / YUNXIAO_ORG_ID / YUNXIAO_DOMAIN), injected
 * by the Java side via params.env → process.env. byte-identical across the two
 * daemon copies (jetbrains-cc-gui/ai-bridge + ai-bridge-server/ai-bridge).
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SUPERVISOR_MCP_NAME = 'supervisor';            // 与 supervisor-tools.js 一致
export const QUERY_BUG_TOOL = 'query_bug_details';
export const QUALIFIED_QUERY_BUG = `mcp__${SUPERVISOR_MCP_NAME}__${QUERY_BUG_TOOL}`;
export const REPORT_FIX_TOOL = 'comment_bug_fix';
export const QUALIFIED_REPORT_FIX = `mcp__${SUPERVISOR_MCP_NAME}__${REPORT_FIX_TOOL}`;

const DEFAULT_DOMAIN = 'openapi-rdc.aliyuncs.com';
const FETCH_TIMEOUT_MS = 15000;
const MAX_FILES = 20;                       // 单次最多下载文件数
const MAX_FILE_BYTES = 8 * 1024 * 1024;     // 单文件 ≤8MB
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;   // 总量 ≤50MB

/**
 * Build the query_bug_details SDK tool. Accepts the resolved zod module (same
 * convention as buildSupervisorMcpServer) and derives `z` internally so the
 * call site can stay identical across both daemon channels.
 */
export function buildQueryBugDetailsTool(sdk, zod) {
  const z = zod?.z ?? zod?.default?.z ?? zod;
  return sdk.tool(
    QUERY_BUG_TOOL,
    '查询云效缺陷的全部信息: 基础信息 + 所有评论 + 附件, 并把描述/评论里的所有截图和附件下载到本地临时目录(返回本地绝对路径)。' +
    '⚠️ 修复缺陷前必须先用 Read 工具逐个查看返回的所有截图本地路径以理解实际画面, 否则你看不到截图里画了什么。传入云效工作项 identifier。',
    { bug_id: z.string().describe('云效工作项 identifier(非 serialNumber)') },
    async (args) => {
      const token = process.env.YUNXIAO_TOKEN;
      const orgId = process.env.YUNXIAO_ORG_ID;
      const domain = process.env.YUNXIAO_DOMAIN || DEFAULT_DOMAIN;
      if (!token || !orgId) {
        return { isError: true, content: [{ type: 'text', text: '云效未配置 token/organizationId' }] };
      }

      // bug_id must be the 云效 internal identifier, NOT the display serialNumber (e.g. BUG-AAXE-850).
      const bugId = (args.bug_id || '').trim();
      if (!bugId) {
        return {
          isError: true,
          content: [{ type: 'text', text: '未提供 bug id：需要云效工作项的内部 identifier（取自缺陷列表项的 identifier 字段），而非显示编号 BUG-xxx。' }],
        };
      }

      const base = `https://${domain}/oapi/v1/projex/organizations/${orgId}/workitems/${encodeURIComponent(bugId)}`;
      const h = { 'x-yunxiao-token': token, 'Content-Type': 'application/json' };

      // 三路并发, 每路独立重试/降级
      const [info, comments, files] = await Promise.all([
        fetchRetry(`${base}`, { headers: h }, { hard: true }),                          // 基础信息: 硬失败
        fetchRetry(`${base}/comments?page=1&perPage=50`, { headers: h }, { hard: false }), // 评论: 软降级
        fetchRetry(`${base}/attachments`, { headers: h }, { hard: false }),             // 附件: 软降级
      ]);
      if (info.error) {
        const hint = info.error.includes('404')
          ? `（「${bugId}」可能是显示编号 serialNumber 而非云效内部 identifier；请用缺陷列表项里的 identifier 重试）`
          : '';
        return { isError: true, content: [{ type: 'text', text: `基础信息获取失败: ${info.error}${hint}` }] };
      }

      const workitem = unwrap(info.data);

      // tmp 目录: daemon 本机 (本地模式=用户机器, 远程模式=ai-bridge-server)
      const dir = join(tmpdir(), 'yunxiao-bugs', bugId.replace(/[^A-Za-z0-9_-]/g, '_'));
      try { mkdirSync(dir, { recursive: true }); } catch (_) { /* best effort */ }

      const budget = { count: 0, bytes: 0, notes: [] };
      const downloaded = [];          // {path, kind:'image'|'file', label}
      const seenFileId = {};          // fileId → local path (复用, 防重复下载)

      // 1) 描述内嵌图
      let descText = extractHtml(strOf(workitem, 'description'));
      {
        const map = {};
        for (const fileId of collectFileIds(descText)) {
          const p = await downloadByFileId(domain, orgId, bugId, fileId, token, dir, 'desc', budget, seenFileId);
          if (p) { map[fileId] = p; downloaded.push({ path: p, kind: 'image', label: '描述内嵌图' }); }
        }
        descText = replaceImgRefs(descText, map);
      }

      // 2) 评论内嵌图
      const commentList = asArray(comments.data);
      const commentsOut = [];
      for (let ci = 0; ci < commentList.length; ci++) {
        const c = commentList[ci] || {};
        const author = displayName(c.user) || displayName(c.creator) || displayName(c.author) || '?';
        // content 可能是 字符串(JSON-wrapped htmlValue / html) 或 对象 {htmlValue,...}(新版 API)
        let content = commentHtml(c);
        const map = {};
        for (const fileId of collectFileIds(content)) {
          const p = await downloadByFileId(domain, orgId, bugId, fileId, token, dir, `comment-${ci + 1}`, budget, seenFileId);
          if (p) { map[fileId] = p; downloaded.push({ path: p, kind: 'image', label: `评论(${author})内嵌图` }); }
        }
        content = replaceImgRefs(content, map);
        commentsOut.push({ author, time: c.gmtCreate || c.createdAt || '', content });
      }

      // 3) 独立附件 (图片必下; 其它附件也下, 只给路径)
      const attList = asArray(files.data);
      const attachmentsOut = [];
      for (const a of attList) {
        const id = strOf(a, 'id');
        const name = strOf(a, 'fileName') || strOf(a, 'name') || (id ? `attachment-${id}` : 'attachment');
        if (!id) { attachmentsOut.push({ name, note: '无 id, 跳过' }); continue; }
        const p = await downloadByFileId(domain, orgId, bugId, id, token, dir, 'att', budget, seenFileId, name);
        if (p) {
          const isImg = /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(p);
          downloaded.push({ path: p, kind: isImg ? 'image' : 'file', label: `附件 ${name}` });
          attachmentsOut.push({ name, localPath: p });
        } else {
          attachmentsOut.push({ name, note: '下载失败/超限' });
        }
      }

      // ---- 组装返回文本 ----
      const images = downloaded.filter((d) => d.kind === 'image');
      const otherFiles = downloaded.filter((d) => d.kind !== 'image');
      const out = [];
      out.push('【基础信息】');
      out.push(JSON.stringify(basicOf(workitem), null, 2));
      out.push('');
      out.push('【描述】');
      out.push(descText || '(空)');
      out.push('');
      out.push(`【评论】(${commentsOut.length} 条)`);
      for (const c of commentsOut) {
        out.push(`— ${c.author}${c.time ? ' @' + c.time : ''}:`);
        out.push(`  ${c.content || '(空)'}`);
      }
      if (comments.error) out.push(`(评论获取失败: ${comments.error})`);
      out.push('');
      out.push(`【已下载截图】${images.length} 张 ⚠️ 修复前必须用 Read 工具逐个查看, 否则看不到截图实际画面:`);
      if (images.length === 0) out.push('  (无内嵌截图)');
      for (const im of images) out.push(`- ${im.path}  (${im.label})`);
      if (otherFiles.length) {
        out.push('');
        out.push(`【已下载附件】${otherFiles.length} 个 (按需用 Read 查看):`);
        for (const f of otherFiles) out.push(`- ${f.path}  (${f.label})`);
      }
      if (files.error) out.push(`(附件列表获取失败: ${files.error})`);
      if (budget.notes.length) {
        out.push('');
        out.push('【下载提示】' + budget.notes.join('; '));
      }

      return { content: [{ type: 'text', text: out.join('\n') }] };
    },
  );
}

/**
 * Build the comment_bug_fix SDK tool. Posts the fix conclusion (cause / fix / test —
 * three mandatory sections) as a comment on the 云效 工作项. Same env + endpoint family
 * as query_bug_details. Single attempt (no retry) to avoid double-posting on a timeout.
 */
export function buildReportBugFixTool(sdk, zod) {
  const z = zod?.z ?? zod?.default?.z ?? zod;
  return sdk.tool(
    REPORT_FIX_TOOL,
    '把缺陷的修复结论作为评论发布到云效缺陷下(修复并通过验证后调用一次)。必须提供三段:缺陷产生的原因、如何修复、如何测试。bug_id 传云效工作项 identifier(非 serialNumber)。',
    {
      bug_id: z.string().describe('云效工作项 identifier(非 serialNumber)'),
      cause: z.string().describe('缺陷产生的原因(根因)'),
      fix: z.string().describe('如何修复的(改了什么/采用的方案)'),
      test: z.string().describe('如何测试/验证(复现步骤或验证证据)'),
    },
    async (args) => {
      const token = process.env.YUNXIAO_TOKEN;
      const orgId = process.env.YUNXIAO_ORG_ID;
      const domain = process.env.YUNXIAO_DOMAIN || DEFAULT_DOMAIN;
      if (!token || !orgId) {
        return { isError: true, content: [{ type: 'text', text: '云效未配置 token/organizationId' }] };
      }
      const bugId = (args.bug_id || '').trim();
      const cause = (args.cause || '').trim();
      const fix = (args.fix || '').trim();
      const test = (args.test || '').trim();
      if (!bugId) {
        return { isError: true, content: [{ type: 'text', text: '未提供 bug id:需要云效工作项内部 identifier(非显示编号 BUG-xxx)。' }] };
      }
      if (!cause || !fix || !test) {
        return {
          isError: true,
          content: [{ type: 'text', text: '修复结论必须同时含三段:cause(原因)、fix(修复)、test(测试),请补全后重试。' }],
        };
      }
      const content =
        '## ✅ 缺陷修复结论(AI 自动生成)\n\n' +
        '**一、缺陷产生的原因**\n' + cause + '\n\n' +
        '**二、如何修复**\n' + fix + '\n\n' +
        '**三、如何测试**\n' + test + '\n';
      const url = `https://${domain}/oapi/v1/projex/organizations/${orgId}/workitems/${encodeURIComponent(bugId)}/comments`;
      const res = await postJson(url, token, { content });
      if (!res.ok) {
        const hint = (res.error || '').includes('404')
          ? `(「${bugId}」可能是 serialNumber 而非云效内部 identifier;请用列表项的 identifier 重试)`
          : '';
        return { isError: true, content: [{ type: 'text', text: `评论发布失败: ${res.error}${hint}` }] };
      }
      return { content: [{ type: 'text', text: `已把修复结论(原因/修复/测试 三段)评论到云效缺陷 ${bugId}。` }] };
    },
  );
}

/** POST JSON with the 云效 token. Single attempt (write op — avoid double-posting on retry). */
async function postJson(url, token, body) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'x-yunxiao-token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!r.ok) {
      let detail = '';
      try { detail = ((await r.text()) || '').slice(0, 300); } catch (_) { /* ignore */ }
      return { ok: false, error: `HTTP ${r.status}${detail ? ': ' + detail : ''}` };
    }
    return { ok: true };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, error: (e && e.name === 'AbortError') ? 'timeout' : ((e && e.message) || String(e)) };
  }
}

// =============================================================================
// 下载: fileId → OpenAPI GetWorkitemFile → OSS 签名 url → 字节 → 写 tmp
// =============================================================================

async function downloadByFileId(domain, orgId, bugId, fileId, token, dir, prefix, budget, seen, fileName) {
  if (seen[fileId]) return seen[fileId];                 // 已下过(同 fileId 复用)
  if (budget.count >= MAX_FILES) { note(budget, `已达 ${MAX_FILES} 个上限, 后续未下`); return null; }
  if (budget.bytes >= MAX_TOTAL_BYTES) { note(budget, '已达总量上限, 后续未下'); return null; }
  try {
    const metaUrl = `https://${domain}/oapi/v1/projex/organizations/${orgId}/workitems/`
      + `${encodeURIComponent(bugId)}/files/${encodeURIComponent(fileId)}`;
    const meta = unwrap(await fetchJson(metaUrl, token));
    const ossUrl = meta && meta.url;
    const name = fileName || (meta && meta.name) || '';
    if (!ossUrl) { note(budget, `${name || fileId} 未取到下载地址`); return null; }

    const got = await fetchBytes(ossUrl);                // OSS 签名 url, 无需 token
    if (!got) { note(budget, `${name || fileId} 下载失败`); return null; }
    if (got.buf.length > MAX_FILE_BYTES) { note(budget, `${name || fileId} 超 8MB 未下`); return null; }
    if (budget.bytes + got.buf.length > MAX_TOTAL_BYTES) { note(budget, `${name || fileId} 超总量未下`); return null; }

    const idx = budget.count + 1;
    const safe = (name || '').replace(/[^A-Za-z0-9._-]/g, '_');
    const fname = (safe && /\.[A-Za-z0-9]+$/.test(safe))
      ? `${idx}-${safe}`
      : `${prefix}-${idx}${extOf(safe) || extFromCt(got.ct) || '.png'}`;
    const p = join(dir, fname);
    writeFileSync(p, got.buf);
    budget.count++; budget.bytes += got.buf.length;
    seen[fileId] = p;
    return p;
  } catch (e) {
    note(budget, `${fileName || fileId} 下载异常: ${(e && e.message) || e}`);
    return null;
  }
}

async function fetchJson(url, token) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { 'x-yunxiao-token': token, 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch (_) {
    clearTimeout(t);
    return null;
  }
}

async function fetchBytes(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: controller.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const ab = await r.arrayBuffer();
    return { buf: Buffer.from(ab), ct: r.headers.get('content-type') || '' };
  } catch (_) {
    clearTimeout(t);
    return null;
  }
}

// =============================================================================
// helpers
// =============================================================================

function note(budget, msg) { if (budget.notes.length < 10) budget.notes.push(msg); }

function unwrap(o) {
  if (!o || typeof o !== 'object') return o;
  if (o.result && typeof o.result === 'object' && !Array.isArray(o.result)) return o.result;
  if (o.data && typeof o.data === 'object' && !Array.isArray(o.data)
      && !('url' in o) && !('subject' in o)) return o.data;
  return o;
}

function asArray(d) {
  if (Array.isArray(d)) return d;
  if (d && Array.isArray(d.result)) return d.result;
  if (d && Array.isArray(d.data)) return d.data;
  if (d && Array.isArray(d.items)) return d.items;
  return [];
}

function strOf(o, k) {
  const v = o && o[k];
  return (v != null && typeof v !== 'object') ? String(v) : '';
}

function displayName(u) {
  if (!u) return '';
  if (typeof u === 'string') return u;
  return u.displayName || u.name || u.nickName || '';
}

/** 云效富文本 description 常是 {"htmlValue":"<html>","jsonMLValue":[...]} JSON 串; 解出 html。 */
function extractHtml(s) {
  if (!s || typeof s !== 'string') return s || '';
  const t = s.trim();
  if (t.startsWith('{') && t.endsWith('}')) {
    try {
      const o = JSON.parse(t);
      for (const k of ['htmlValue', 'html', 'value', 'content']) {
        if (typeof o[k] === 'string' && o[k]) return o[k];
      }
    } catch (_) { /* not the wrapper json — treat as plain html */ }
  }
  return s;
}

/** Comment content tolerant of 云效 variations: string(JSON/html) or object {htmlValue}. */
function commentHtml(c) {
  if (!c) return '';
  const el = c.content;
  if (typeof el === 'string') {
    return extractHtml(el);                                  // handles JSON-wrapped {htmlValue}
  }
  if (el && typeof el === 'object') {
    for (const k of ['htmlValue', 'html', 'value', 'content', 'text']) {
      if (typeof el[k] === 'string' && el[k]) return el[k];
    }
  }
  if (typeof c.htmlValue === 'string' && c.htmlValue) return c.htmlValue;
  for (const k of ['text', 'description', 'body']) {
    if (typeof c[k] === 'string' && c[k]) return c[k];
  }
  return '';
}

function collectFileIds(html) {
  if (!html) return [];
  const re = /fileIdentifier=([A-Za-z0-9_-]+)/g;
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(html)) !== null) {
    if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  }
  return out;
}

/** Replace each <img .. fileIdentifier=X ..> / ![..](..X..) with a "Read this file" marker. */
function replaceImgRefs(html, fileIdToPath) {
  if (!html) return html;
  let out = html;
  for (const [fileId, path] of Object.entries(fileIdToPath || {})) {
    const e = escapeRe(fileId);
    const marker = `【截图,已下载→用 Read 查看: ${path}】`;
    out = out
      .replace(new RegExp('<img[^>]*' + e + '[^>]*>', 'gi'), marker)
      .replace(new RegExp('!\\[[^\\]]*\\]\\([^)]*' + e + '[^)]*\\)', 'g'), marker);
  }
  return out;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function extOf(name) {
  const m = /(\.[A-Za-z0-9]+)$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

function extFromCt(ct) {
  const c = (ct || '').toLowerCase();
  if (c.includes('png')) return '.png';
  if (c.includes('jpeg') || c.includes('jpg')) return '.jpg';
  if (c.includes('gif')) return '.gif';
  if (c.includes('webp')) return '.webp';
  if (c.includes('bmp')) return '.bmp';
  if (c.includes('svg')) return '.svg';
  return '';
}

function basicOf(d) {
  if (!d || typeof d !== 'object') return d;
  return {
    identifier: d.identifier || d.id,
    serialNumber: d.serialNumber,
    subject: d.subject,
    status: displayName(d.status) || d.status,
    assignedTo: displayName(d.assignedTo),
    creator: displayName(d.creator),
    priority: displayName(d.priority),
    gmtCreate: d.gmtCreate,
    gmtModified: d.gmtModified,
  };
}

/**
 * Retry: transient errors (timeout / 429 / 5xx) retry 3× with 200/400/800ms
 * backoff; deterministic errors (401/403/404) fail immediately. `hard` is a
 * call-site marker for the caller's degradation policy (unused here). Mirrors
 * the AbortController-timeout fetch in mcp-status/http-verifier.js.
 */
async function fetchRetry(url, opts, { hard }) {
  void hard;
  let lastErr = '';
  for (let i = 0; i < 3; i++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const r = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(timeoutId);
      if (r.ok) {
        return { data: await r.json(), error: null };
      }
      if ([401, 403, 404].includes(r.status)) {
        return { data: null, error: `HTTP ${r.status}` }; // 确定性错误, 不重试
      }
      lastErr = `HTTP ${r.status}`;                        // 429 / 5xx → 重试
    } catch (e) {
      clearTimeout(timeoutId);
      lastErr = (e && e.name === 'AbortError') ? 'timeout' : ((e && e.message) || String(e));
    }
    if (i < 2) {
      await new Promise((s) => setTimeout(s, 200 * 2 ** i)); // 退避 200/400/800ms
    }
  }
  return { data: null, error: lastErr };
}
