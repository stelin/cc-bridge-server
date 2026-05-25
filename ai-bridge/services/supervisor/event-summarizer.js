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
    case 'composite_summary':
      // Phase 1 (2026-05-23): one supervisor turn now covers a batch of main-AI
      // events accumulated since the previous tick, instead of one event per
      // turn. The Java SupervisorMonitor builds this envelope; we expand each
      // child event using the existing per-type formatters so the supervisor
      // sees the same wording as before plus an outer batch banner.
      return formatComposite(p, elapsed);
    // Protocol v2 (2026-05-24): autonomous collab events.
    case 'turn_report':
      return formatTurnReport(p, elapsed);
    case 'subagent_stop':
      return formatSubagentStop(p, elapsed);
    case 'budget_warning':
      return formatBudgetWarning(p, elapsed);
    case 'budget_exceeded':
      return formatBudgetExceeded(p, elapsed);
    case 'directive_lost':
      return formatDirectiveLost(p, elapsed);
    // Phase 6 (2026-05-24): autonomy control layer events.
    case 'step_blocked':
      return formatStepBlocked(p, elapsed);
    case 'replan_due':
      return formatReplanDue(p, elapsed);
    default:
      return `## EVENT [${elapsed} | ${type}]\n${safeJson(p)}`;
  }
}

// =========================== Protocol v2 formatters ===========================

/**
 * Phase 2 (2026-05-24): main AI's structured work report. Replaces the legacy
 * turn_end for Pair v2 — payload comes from the mcp__main__report_turn_completion
 * tool the main AI must call before ending each turn.
 */
function formatTurnReport(p, elapsed) {
  const lines = [
    `## EVENT [${elapsed} | turn_report]`,
    `turnId: ${p.turnId ?? '?'}` + (p.directiveId ? `  (directive ${p.directiveId})` : ''),
  ];
  if (p.summary) {
    lines.push('', `summary: ${p.summary}`);
  }
  if (Array.isArray(p.deliverables) && p.deliverables.length > 0) {
    lines.push('', 'deliverables:');
    for (const d of p.deliverables) {
      const conf = d.confidence ? ` [${d.confidence}]` : '';
      lines.push(`  - ${d.path}${conf}: ${d.change}`);
    }
  }
  if (Array.isArray(p.verifications) && p.verifications.length > 0) {
    lines.push('', 'verifications:');
    for (const v of p.verifications) {
      const mark = v.pass ? '✓' : '✗';
      lines.push(`  ${mark} ${v.command}`);
      if (!v.pass && v.stderrTail) {
        lines.push(`     stderr: ${truncate(v.stderrTail, 400)}`);
      }
    }
  }
  if (p.selfAssessment) {
    const sa = p.selfAssessment;
    lines.push('', `selfAssessment.confidence: ${sa.confidence ?? '?'}`);
    if (Array.isArray(sa.concerns) && sa.concerns.length > 0) {
      lines.push('selfAssessment.concerns:');
      for (const c of sa.concerns) lines.push(`  - ${c}`);
    }
    if (sa.suggestedReview) {
      lines.push(`selfAssessment.suggestedReview: ${sa.suggestedReview}`);
    }
  }
  if (p.subagentSummary && typeof p.subagentSummary.count === 'number') {
    lines.push('', `subagentSummary: ${p.subagentSummary.count} subagent(s), `
      + `${p.subagentSummary.totalDurationMs ?? 0}ms total`);
  }
  if (typeof p.durationMs === 'number' && p.durationMs > 0) {
    lines.push(`durationMs: ${p.durationMs}`);
  }
  if (p.spilledPath) {
    lines.push(`spilledPath: ${p.spilledPath}  (full text on disk, Read when needed)`);
  }
  lines.push(
    '',
    '## review 协议(v2 分诊)',
    '按 selfAssessment.confidence 决定 review 深度:',
    '- confidence=high + verifications 全 pass → 信任,直接通过(可记一条 trusted_pass 决策)',
    '- confidence=medium → 自读 Read 关键文件验证',
    '- confidence=low 或 concerns 非空 → 必派 code reviewer 子 agent;brief 必含 suggestedReview',
    '',
    'decision 必通过 `update_state(decisionAppend={...})` 留痕。',
  );
  return lines.join('\n');
}

/**
 * Main-AI subagent finished. SDK hook payload is forwarded as-is by
 * subagent-stop-hook.js. Supervisor sees the lastAssistantMessage summary
 * and an optional transcriptPath for deep-dive Read.
 */
function formatSubagentStop(p, elapsed) {
  const lines = [
    `## EVENT [${elapsed} | subagent_stop]`,
    `agentId: ${p.agentId ?? '?'} (type ${p.agentType ?? '?'})`,
  ];
  if (p.taskSubject) lines.push(`task: ${p.taskSubject}`);
  if (typeof p.durationMs === 'number' && p.durationMs > 0) {
    lines.push(`durationMs: ${p.durationMs}`);
  }
  if (p.lastAssistantMessage) {
    lines.push('', `lastMessage: ${truncate(p.lastAssistantMessage, 1000)}`);
  }
  if (p.transcriptPath) {
    lines.push('', `transcriptPath: ${p.transcriptPath}`,
      '(Read 该文件可见子 agent 完整对话;若 lastMessage 足够说明问题,可不读以节省 token)');
  }
  return lines.join('\n');
}

function formatBudgetWarning(p, elapsed) {
  const max = typeof p.maxRatio === 'number' ? (p.maxRatio * 100).toFixed(0) : '?';
  return [
    `## EVENT [${elapsed} | budget_warning]`,
    `已使用预算 ${max}% (任一维度触及 80% 阈值)。`,
    'tokens: ' + ratioStr(p.tokenRatio),
    'duration: ' + ratioStr(p.durationRatio),
    'steps: ' + ratioStr(p.stepRatio),
    'subagents: ' + ratioStr(p.subagentRatio),
    '',
    '建议:',
    '- 评估剩余 step,识别可裁剪的非关键 step',
    '- 若可裁剪 → save_plan(source="replan") 移除非关键 step + record_alert(severity=warn)',
    '- 不可裁剪 → 继续推进,准备 partial completion 报告',
  ].join('\n');
}

function formatBudgetExceeded(p, elapsed) {
  return [
    `## EVENT [${elapsed} | budget_exceeded]`,
    `已超出预算 (${ratioStr(p.maxRatio)})。Pair 即将被 Java 端强制暂停。`,
    '本轮可以做最后一次收尾(可选):',
    '- 若有未完成 step,inject_prompt 让主 AI 收尾或保存现场',
    '- 不要派新子 agent,不要 save_plan',
    '- 调 emit_action(wait) 结束本轮即可',
  ].join('\n');
}

function formatDirectiveLost(p, elapsed) {
  return [
    `## EVENT [${elapsed} | directive_lost]`,
    `directiveId: ${p.directiveId ?? '?'} 5 分钟内未收到主 AI ack。`,
    p.lastObjective ? `objective: ${p.lastObjective}` : '',
    '',
    '请决定:',
    '- 重新派一次(emit_action inject_prompt, 复用相同 objective)',
    '- 或 record_alert(C1, fallback="跳过该 step") 标 step blocked 继续下一个',
  ].filter(Boolean).join('\n');
}

/**
 * Phase 6 (2026-05-24): F2 step_blocked. Java side has already counted N
 * consecutive directive_lost without an intervening approve_and_continue,
 * reset the counter, and emitted this event. Supervisor should mark the
 * current step as blocked + advance to the next step (not keep retrying).
 */
function formatStepBlocked(p, elapsed) {
  const failureCount = typeof p.failureCount === 'number' ? p.failureCount : 3;
  const objective = p.lastObjective || '(未知 objective)';
  return [
    `## EVENT [${elapsed} | step_blocked]`,
    `连续 ${failureCount} 次 inject_prompt 超时未 ack,主 AI 卡住或拒不执行。`,
    `recommendation: ${p.recommendation || 'skip_step'}`,
    `last objective: ${objective}`,
    '',
    '请按以下顺序处理:',
    '1. record_alert(C2, severity="alert", category="C2",',
    '   fallback_choice="skip_step", reason="main-AI 卡住 3 轮未 ack")',
    '2. progress_update 把当前 step 标记为 blocked',
    '3. emit_action approve_and_continue (mark_step_complete=null) 跳过该 step,',
    '   继续下一个 step',
  ].join('\n');
}

/**
 * Phase 6 (2026-05-24): T1 replan_due. Periodic (every 5 approved steps) or
 * post-alert nudge to self-evaluate the plan. Supervisor should派 planner 子
 * agent (or assess inline if cheap) and save_plan(source="replan") only when
 * it materially changes the remaining work.
 */
function formatReplanDue(p, elapsed) {
  const trigger = p.trigger || 'periodic';
  const stepsCompleted = typeof p.stepsCompleted === 'number' ? p.stepsCompleted : 0;
  const triggerNote = trigger === 'after_alert'
    ? '刚发了一次 alert,适合趁机检查 plan 后续是否仍然成立。'
    : `已完成 ${stepsCompleted} 步,触发周期性 RE-PLAN 检查点。`;
  return [
    `## EVENT [${elapsed} | replan_due]`,
    `trigger: ${trigger}`,
    triggerNote,
    '',
    '请做:',
    '1. 对照已完成 step + 现状,自评剩余 plan 是否仍然合理',
    '2. 如有调整,派 planner 子 agent 重算,然后 mcp__supervisor__save_plan(source="replan")',
    '3. 如无调整,在 update_state decisionAppend 里记 confidence=high 直接继续',
    '不要无脑 replan — 计划稳定时跳过本次检查也算合理决策。',
  ].join('\n');
}

function ratioStr(r) {
  if (typeof r !== 'number' || !Number.isFinite(r)) return 'n/a';
  return `${(r * 100).toFixed(0)}%`;
}

/**
 * Phase 1 (2026-05-23): render a batch of main-AI events that accumulated in
 * the Java EventCollector between two supervisor ticks. Each child event is
 * passed back through {@link summarizeEvent} so the existing per-type
 * formatters are reused without duplication.
 */
function formatComposite(p, elapsed) {
  const events = Array.isArray(p.events) ? p.events : [];
  const dropped = Number.isFinite(p.droppedSincePrevious) ? p.droppedSincePrevious : 0;
  const tick = Number.isFinite(p.tick) ? p.tick : '?';
  const urgent = Number.isFinite(p.urgentCount) ? p.urgentCount : 0;
  const windowSec = (p.batchStartMs && p.batchEndMs)
    ? Math.max(0, Math.round((p.batchEndMs - p.batchStartMs) / 1000))
    : null;
  const isHealthCheck = p.healthCheck === true;
  // Phase 4 (2026-05-24): one-shot inherited-generation banner. The Java
  // SupervisorMonitor sets payload.generationBanner exactly once after a
  // rotation, then clears it; subsequent ticks omit the field.
  const generationBanner = typeof p.generationBanner === 'string' && p.generationBanner.length > 0
    ? p.generationBanner : null;

  // Header banner
  const headerParts = [`## BATCH [${elapsed} | tick #${tick}]`];
  if (windowSec != null) headerParts.push(`window=${windowSec}s`);
  headerParts.push(`events=${events.length}`);
  if (urgent > 0) headerParts.push(`urgent=${urgent}`);
  if (dropped > 0) headerParts.push(`⚠ dropped=${dropped}`);
  if (isHealthCheck) headerParts.push('health_check');
  const header = headerParts.join(' | ');

  // Empty batch (idle health-check tick): give the supervisor a no-op note
  // so the model has explicit context for the empty turn.
  if (events.length === 0) {
    const lines = [header, ''];
    if (generationBanner) {
      lines.push('## [NEW_GENERATION_BANNER]', generationBanner, '');
    }
    if (dropped > 0) {
      lines.push(
        `本批次没有新事件,但有 ${dropped} 个事件在等待期间被丢弃 (ring overflow)。`,
        '如果担心遗漏,可调用 Read/Grep 复查仍在推进的文件状态。',
        '否则**必须**调用 `emit_action(action="wait", reason="健康检查无事件")` 结束本轮。',
      );
    } else {
      lines.push(
        '本批次没有新事件 (健康检查 tick)。',
        '**必须**调用 `emit_action(action="wait", reason="健康检查无事件")` 结束本轮 — 仅输出思考文本会触发 SUPERVISOR_POST_EVENT_TIMEOUT。',
      );
    }
    return lines.join('\n');
  }

  // Multi-event: render header + each child via the existing summarizer.
  const sections = [header, ''];
  if (generationBanner) {
    sections.push(
      '## [NEW_GENERATION_BANNER]',
      generationBanner,
      '你刚接管这个 pair。在你的 handoff 文档产生到现在的这段时间里, 主 AI 又跑了下面 ' + events.length + ' 个事件,',
      '其中部分可能在你的认知之前发生但你不知道。请先按 handoff 文档里的 anchoredFacts 校对, 再做决策。',
      '',
    );
  }
  if (dropped > 0) {
    sections.push(`> ⚠️ 注意:有 ${dropped} 个较早事件在缓冲区溢出时被丢弃。`,
                  '> 下面是仍保留在缓冲区里的最新事件,按时间顺序。', '');
  }
  for (let i = 0; i < events.length; i++) {
    const child = events[i];
    sections.push(`---  child #${i + 1}  ---`);
    sections.push(summarizeEvent(child));
    sections.push('');
  }
  sections.push(
    '',
    '## 批处理决策提示',
    '以上是过去 ~' + (windowSec ?? '?') + 's 内主 AI 的事件流。你可以:',
    '- 对最关键的事件做出单一 action (inject_prompt / escalate / approve_and_continue / wait)',
    '- 如果多个事件互相关联,综合后给一条 action,不要 emit 多次',
    '- 仍需遵守 review 协议:涉及 modified_in_plan 文件必须 Read 验证后再决策',
    '- **必须**以 emit_action 工具调用结束本轮,只输出文字会触发 120s 超时'
  );
  return sections.join('\n');
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

  // Phase 0 (2026-05-24): main AI's natural-language reply (truncated by the
  // Java side at 8000 chars). Critical for the supervisor to see things like
  // manifest YAML output that aren't visible through toolUses alone.
  if (typeof p.assistantText === 'string' && p.assistantText.length > 0) {
    lines.push(
      '',
      '## 主 AI 本轮自然语言回复（可能截断）',
      p.assistantText,
    );
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
