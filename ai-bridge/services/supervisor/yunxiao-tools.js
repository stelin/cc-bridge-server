/**
 * Yunxiao (Alibaba Cloud DevOps / 云效) bug-detail tool for the supervisor MCP.
 *
 * Exposes a single tool — `query_bug_details` — that aggregates a 云效 工作项's
 * 基础信息 + 所有评论 + 附件(含附件评论) in one call, so the缺陷监督者
 * (bug-supervisor) can pull full context before planning a fix.
 *
 * Mounted onto the same `supervisor` MCP server as emit_action (see
 * channels/supervisor-channel.js). Credentials come from the daemon env
 * (process.env.YUNXIAO_TOKEN / YUNXIAO_ORG_ID / YUNXIAO_DOMAIN), injected by the
 * Java side via params.env → process.env. This file is byte-identical across the
 * two daemon copies (jetbrains-cc-gui/ai-bridge + ai-bridge-server/ai-bridge).
 *
 * The three sub-requests run concurrently, each with its own retry/degradation:
 *   - 基础信息 (GetWorkitem)   — hard failure → the whole tool errors.
 *   - 评论 / 附件             — soft degradation → annotated as missing in payload.
 * Transient errors (timeout / 429 / 5xx) retry 3× with 200/400/800ms backoff;
 * deterministic errors (401/403/404) fail immediately.
 */

export const SUPERVISOR_MCP_NAME = 'supervisor';            // 与 supervisor-tools.js 一致
export const QUERY_BUG_TOOL = 'query_bug_details';
export const QUALIFIED_QUERY_BUG = `mcp__${SUPERVISOR_MCP_NAME}__${QUERY_BUG_TOOL}`;

const DEFAULT_DOMAIN = 'openapi-rdc.aliyuncs.com';
const FETCH_TIMEOUT_MS = 15000;

/**
 * Build the query_bug_details SDK tool. Accepts the resolved zod module (same
 * convention as buildSupervisorMcpServer) and derives `z` internally so the
 * call site can stay identical across both daemon channels.
 */
export function buildQueryBugDetailsTool(sdk, zod) {
  const z = zod?.z ?? zod?.default?.z ?? zod;
  return sdk.tool(
    QUERY_BUG_TOOL,
    '查询云效缺陷的全部信息: 基础信息 + 所有评论 + 附件(含附件评论)。传入云效工作项 identifier。',
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
        // 基础信息 (GetWorkitem): 已确认 path, 硬失败
        fetchRetry(`${base}`, { headers: h }, { hard: true }),
        // TODO(yunxiao): path 待 OpenAPI 调试台 pin —— 评论: 软降级
        fetchRetry(`${base}/comments`, { headers: h }, { hard: false }),
        // TODO(yunxiao): path 待 OpenAPI 调试台 pin —— 附件: 软降级
        fetchRetry(`${base}/attachments`, { headers: h }, { hard: false }),
      ]);
      if (info.error) {
        // A 404 on GetWorkitem almost always means a display serialNumber was passed
        // instead of the internal identifier — tell the model how to recover.
        const hint = info.error.includes('404')
          ? `（「${bugId}」可能是显示编号 serialNumber 而非云效内部 identifier；请用缺陷列表项里的 identifier 重试）`
          : '';
        return { isError: true, content: [{ type: 'text', text: `基础信息获取失败: ${info.error}${hint}` }] };
      }

      const payload = {
        basic: info.data,
        comments: comments.error ? `(评论获取失败: ${comments.error})` : comments.data,
        attachments: files.error ? `(附件获取失败: ${files.error})` : files.data,
      };
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    },
  );
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
