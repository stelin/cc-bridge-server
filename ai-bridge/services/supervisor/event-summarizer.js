/**
 * Event Summarizer.
 *
 * Java's PairSession EventBus forwards filtered Main-AI events to a Supervisor
 * session as compact, structured summaries — not raw NDJSON streams. The
 * summarizer here is the canonical formatter on the daemon side: it normalizes
 * incoming event objects to a small human/LLM-friendly text payload that the
 * Supervisor LLM consumes as a `user` message.
 *
 * Token-saving rules:
 *   - tool_use individual events: NOT forwarded (rolled up into turn_end)
 *   - content_delta: NOT forwarded
 *   - turn_end / error / idle_timeout / off_plan_detected / step_verify_*: forwarded
 *
 * The Java EventFilter is the source of truth for "what to forward". This
 * module is the source of truth for "how the forwarded payload looks".
 */

/**
 * @param {object} event
 * @param {string} event.type - 'turn_end' | 'error' | 'idle_timeout' | 'off_plan_detected'
 *                              | 'verify_result' | 'review_result' | 'human_response'
 * @param {object} [event.payload]
 * @returns {string} markdown-flavored block to be sent as a user message
 */
export function summarizeEvent(event) {
  if (!event || typeof event !== 'object') {
    return '## EVENT [unknown]\n(empty event)';
  }

  const type = event.type || 'unknown';
  const p = event.payload || {};
  const elapsed = typeof p.elapsedSeconds === 'number'
    ? `T+${p.elapsedSeconds}s`
    : (p.timestamp ? new Date(p.timestamp).toISOString() : 'now');

  switch (type) {
    case 'turn_end':
      return formatTurnEnd(p, elapsed);
    case 'error':
      return formatError(p, elapsed);
    case 'idle_timeout':
      return formatIdle(p, elapsed);
    case 'off_plan_detected':
      return formatOffPlan(p, elapsed);
    case 'verify_result':
      return formatVerify(p, elapsed);
    case 'review_result':
      return formatReview(p, elapsed);
    case 'human_response':
      return formatHumanResponse(p, elapsed);
    case 'user_input':
      return formatUserInput(p, elapsed);
    case 'start':
      return formatStart(p, elapsed);
    default:
      return `## EVENT [${elapsed} | ${type}]\n${safeJson(p)}`;
  }
}

function formatUserInput(p, elapsed) {
  const text = (p.text || '').trim();
  return [
    `## USER MESSAGE [${elapsed}]`,
    '',
    text,
    '',
    '上面是用户直接对你（Supervisor）的指令。它通常包含：',
    '- 编码方案在哪里（路径 / 引用文档）',
    '- 编码要求和规范描述',
    '- 期望你协调主 AI 完成的任务',
    '',
    '请按你的职责理解后行动。常见决策：',
    '- 任务清楚 → 输出 inject_prompt 让主 AI 开始（payload.prompt 写明第一步要做什么）',
    '- 任务模糊 / 缺关键信息 → escalate_to_human 反问用户',
    '- 用户在调整你的策略（例如"以后宽松点"）→ wait（沉默接受），下次决策时遵守',
  ].join('\n');
}

function formatStart(p, elapsed) {
  return [
    `## EVENT [${elapsed} | start]`,
    `主 AI 会话已就绪。当前步骤 = ${p.currentStep ?? 1}/${p.totalSteps ?? '?'}`,
    p.currentStepTitle ? `下一步: ${p.currentStepTitle}` : '',
    '',
    '请决策（首次启动可输出 inject_prompt 把第一步指令发给主 AI）。',
  ].filter(Boolean).join('\n');
}

function formatTurnEnd(p, elapsed) {
  const lines = [
    `## EVENT [${elapsed} | turn_end]`,
    `step: ${p.step ?? '?'} (${p.stepTitle ?? '?'})`,
  ];
  if (Array.isArray(p.toolUses) && p.toolUses.length > 0) {
    lines.push('tool_uses:');
    for (const tu of p.toolUses) {
      const ok = tu.ok === false ? '✗' : '✓';
      const path = tu.path ? ` ${tu.path}` : '';
      lines.push(`  - ${tu.tool}${path} ${ok}`);
    }
  }
  if (Array.isArray(p.modifiedFilesInPlan) && p.modifiedFilesInPlan.length > 0) {
    lines.push(`modified_in_plan: [${p.modifiedFilesInPlan.join(', ')}]`);
  }
  if (Array.isArray(p.modifiedFilesOffPlan) && p.modifiedFilesOffPlan.length > 0) {
    lines.push(`modified_off_plan: [${p.modifiedFilesOffPlan.join(', ')}]  ⚠️`);
  }
  if (typeof p.durationMs === 'number') {
    lines.push(`duration_ms: ${p.durationMs}`);
  }
  lines.push(
    '',
    '## 必做（review 协议）',
    '在 emit_action 之前，**必须**对 modified_in_plan 中的文件至少调用一次 `Read`（关键段即可）。',
    '若主 AI 自述"加了 X / 已处理 Y"，必须用 `Grep` 验证是否真的存在，不可只看自然语言相信。',
    '跳过文件工具直接 emit_action 视为协议违例。'
  );
  return lines.join('\n');
}

function formatError(p, elapsed) {
  return [
    `## EVENT [${elapsed} | error]`,
    `step: ${p.step ?? '?'}`,
    `code: ${p.code ?? '?'}`,
    typeof p.status === 'number' ? `status: ${p.status}` : '',
    typeof p.retryAfter === 'number' ? `retry_after: ${p.retryAfter}s` : '',
    p.message ? `message: ${p.message}` : '',
    typeof p.retryCount === 'number' ? `retry_count: ${p.retryCount}` : '',
    '',
    '请按 escalation_rules 决定自愈或升级。',
  ].filter(Boolean).join('\n');
}

function formatIdle(p, elapsed) {
  return [
    `## EVENT [${elapsed} | idle_timeout]`,
    `step: ${p.step ?? '?'}`,
    `idle_seconds: ${p.idleSeconds ?? '?'}`,
    '',
    '主 AI 长时间未输出。请判断是死循环 / 正常等待 / 需介入。',
  ].join('\n');
}

function formatOffPlan(p, elapsed) {
  return [
    `## EVENT [${elapsed} | off_plan_detected]`,
    `step: ${p.step ?? '?'}`,
    `off_plan_files: [${(p.files ?? []).join(', ')}]`,
    '',
    '主 AI 修改了 plan 外文件。方案 = 标准答案，请 escalate_to_human。',
  ].join('\n');
}

function formatVerify(p, elapsed) {
  const status = p.pass ? 'PASS ✓' : 'FAIL ✗';
  const lines = [
    `## EVENT [${elapsed} | verify_result] ${status}`,
    `step: ${p.step ?? '?'}`,
    `command: ${p.command ?? '?'}`,
    `attempt: ${p.attempt ?? 1}`,
  ];
  if (!p.pass) {
    lines.push('', '## stderr', truncate(p.stderr || '(empty)', 1200));
  }
  lines.push('', p.pass
    ? '验证通过。如需 review，可发起 review_request；否则推进下一步。'
    : '验证失败。请反馈具体错误给主 AI（inject_prompt）或 escalate。');
  return lines.join('\n');
}

function formatReview(p, elapsed) {
  if (p.pass) {
    return [
      `## EVENT [${elapsed} | review_result] PASS ✓`,
      `step: ${p.step ?? '?'}`,
      `reviewer: ${p.reviewerId ?? 'self'}`,
      '',
      '所有审查规范通过。请推进下一步。',
    ].join('\n');
  }
  const lines = [
    `## EVENT [${elapsed} | review_result] FAIL ✗`,
    `step: ${p.step ?? '?'}`,
    `reviewer: ${p.reviewerId ?? 'self'}`,
    `issues:`,
  ];
  for (const issue of p.issues ?? []) {
    lines.push(`  - [${issue.rule ?? 'rule'}] ${issue.file ?? '?'}:${issue.line ?? '?'} — ${issue.message ?? ''}`);
  }
  lines.push('', '请把这些问题以 inject_prompt 反馈给主 AI。');
  return lines.join('\n');
}

function formatHumanResponse(p, elapsed) {
  return [
    `## EVENT [${elapsed} | human_response]`,
    `choice: ${p.choice ?? '?'}`,
    p.note ? `note: ${p.note}` : '',
    '',
    '用户已决策。请继续。',
  ].filter(Boolean).join('\n');
}

function safeJson(obj) {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

function truncate(s, n) {
  if (!s) return '';
  if (s.length <= n) return s;
  return s.slice(0, n) + `\n... (truncated, ${s.length - n} more chars)`;
}
