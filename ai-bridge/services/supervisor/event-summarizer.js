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

/**
 * Plan A (2026-06-10): planning directive prepended to a task-bearing event
 * (user_input / start) when Java flags it via payload.planningRequired (no plan
 * yet). Tells the supervisor to produce its structured plan via emit_plan first.
 */
const PLANNING_DIRECTIVE_LINES = [
  '## [PLANNING_REQUIRED]',
  '这是本任务的首条任务事件。你的**第一步**：调用 `emit_plan` 把任务拆成有序步骤，',
  '每步写明 owner（默认 MAIN_AI）和**验收标准**（之后据此 Read 真实产物核验，不是听主 AI 自述）。',
  '只做结构化、不发明目标。emit_plan 之后在同一轮用 `dispatch_to_main_ai` 派发第 1 步。',
  '计划随后锁定：要改走 `emit_action(request_amendment)`，不要再次 emit_plan。',
  '',
];

/**
 * Plan A resume directive prepended to the first event after a restart that
 * restored a non-terminal plan (Java sets payload.resuming): trust DONE, skip
 * TODO, re-verify the IN_PROGRESS step against reality.
 */
const RESUME_DIRECTIVE_LINES = [
  '## [RESUME] 你在恢复一个已有进度的计划',
  '核验规则：**已完成(DONE)步**信任、不复查；**未开始(TODO)步**不查；',
  '**正在执行(IN_PROGRESS)步必须对账**——先 Read 现场、对照该步验收标准判断实际完成度（可能已部分完成），',
  '再决定 dispatch_to_main_ai 续做 / emit_action(approve_and_continue, mark_step_complete) 标完成 / retry_main_ai_with_hint 重做。',
  '可 Read `plan.md` 看完整计划与进度，不要凭记忆臆断。',
  '',
];

export function summarizeEvent(event) {
  if (!event || typeof event !== 'object') {
    return '## EVENT [unknown]\n(empty event)';
  }

  const type = event.type || 'unknown';
  const p = event.payload || {};
  const elapsed = typeof p.elapsedSeconds === 'number'
    ? `T+${p.elapsedSeconds}s`
    : (p.timestamp ? new Date(p.timestamp).toISOString() : 'now');

  const body = summarizeEventBody(type, p, elapsed);
  // Plan A resume: prepend the IN_PROGRESS reconciliation directive on the first
  // event after a restart that restored a non-terminal plan (Java sets resuming).
  if (p && p.resuming) {
    return RESUME_DIRECTIVE_LINES.join('\n') + '\n\n' + body;
  }
  return body;
}

function summarizeEventBody(type, p, elapsed) {
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
    // v3.1 (2026-05-26): anti-hallucination state-machine guard rejection.
    // Java-side ActionRouter rejected the previous emit_action; the supervisor
    // MUST re-emit with a valid action this turn. Without a dedicated formatter
    // this fell through to safeJson dump and got ignored, causing the
    // wait-narrate-then-wait-again loop the user reported.
    case 'action_rejected':
      return formatActionRejected(event, elapsed);
    default:
      return `## EVENT [${elapsed} | ${type}]\n${safeJson(p)}`;
  }
}

/**
 * v3.1 (2026-05-26): make the state-machine rejection impossible to ignore.
 * Supervisor's LLM tends to weight free-form system events lower than its own
 * narration — so we frame this as the highest-priority directive of the turn,
 * with explicit "do this NOW, do not narrate" guidance.
 */
function formatActionRejected(event, elapsed) {
  // Reason/suggestion sit at event-top-level in Java's payload, not under
  // event.payload (see ActionRouter.sendActionRejectionToSupervisor).
  const reason = (event && typeof event.reason === 'string') ? event.reason
    : (event && event.payload && typeof event.payload.reason === 'string') ? event.payload.reason
    : '(unspecified)';
  const suggestion = (event && typeof event.suggestion === 'string') ? event.suggestion
    : (event && event.payload && typeof event.payload.suggestion === 'string') ? event.payload.suggestion
    : '(no suggestion)';
  return [
    `## ⛔ EVENT [${elapsed} | ACTION_REJECTED — 本轮最高优先级]`,
    '',
    '你的上一轮 emit_action 被 Java 端 state-machine guard 拒绝了。**本轮必须重发正确 action,不准再 wait**。',
    '',
    `**拒绝原因**: ${reason}`,
    '',
    `**修正方法**: ${suggestion}`,
    '',
    '## 🚨 强制规则(违反会再次被拒)',
    '',
    '1. **本轮 emit_action 不允许是 wait 或 wait_for_contract** — 选 inject_prompt / complete_plan / escalate_to_human 之一',
    '2. **不要 narrate "我已经派单了" 之类的话** — 你上一轮就这么 narrate 但实际选了 wait,是 narration-action 不一致的幻觉。本轮直接做,不要说"已经做过"',
    '3. **如果你以为已经派单**: 检查事实 —— 看 Open 合同计数,看你最近一次 emit_action 的实际类型。narration 可能在骗你',
    '4. **常见错误**: "等待主 AI 完成 X 回执" 这种话只有在 Open > 0 时才合法;你看到这条说明 Open = 0,你必须自己发 inject_prompt',
    '',
    '现在立即调用正确的 emit_action,**不要先输出大段思考再调**。',
  ].join('\n');
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
    '- 若可裁剪 → emit_action(request_amendment, {proposal:"移除非关键 step …"}) + record_alert(severity=warn)（计划已锁定，改动走 amendment）',
    '- 不可裁剪 → 继续推进,准备 partial completion 报告',
  ].join('\n');
}

function formatBudgetExceeded(p, elapsed) {
  return [
    `## EVENT [${elapsed} | budget_exceeded]`,
    `已超出预算 (${ratioStr(p.maxRatio)})。Pair 即将被 Java 端强制暂停。`,
    '本轮做最后一次收尾:',
    '- 若有未完成 step → emit_action(inject_prompt) 让主 AI 收尾或保存现场',
    '- 若已无未完成 step → emit_action(complete_plan, {summary: "预算超出,提前结束"}) 显式收尾',
    '- 不要派新子 agent,不要 emit_plan(计划已存在)',
    '- v3.1 提醒: 不要 emit_action(wait) — 没 OPEN 合同时会被 state-machine guard 拒绝',
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
 * agent (or assess inline if cheap) and emit_action(request_amendment) only when
 * it materially changes the remaining work (the plan is locked after emit_plan).
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
    '2. 如有调整,emit_action(request_amendment, {proposal:"…"}) 提议修改（计划已锁定，改动走 amendment，不要再 emit_plan）',
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
/**
 * 2026-06-11 (next-step dispatch fix): rendered when Java flags
 * payload.nextStepToDispatch — the plan is in PENDING_DECISION with an
 * UNDISPATCHED next TODO step and nothing in flight (the supervisor just
 * approved the previous step). The post-approve wake otherwise carries an empty
 * batch whose text says "emit_action wait", so the supervisor never dispatches
 * the next step. This block replaces that with an explicit "dispatch it now"
 * directive, and frames it as a first-dispatch (not an advance) so it never
 * waits for a turn_report nobody can produce.
 */
function buildNextStepDispatchLines(ns) {
  const idx = Number.isFinite(ns.index) ? ns.index : null;
  const total = Number.isFinite(ns.total) ? ns.total : null;
  const title = (typeof ns.title === 'string' && ns.title) ? ns.title : null;
  const label = idx != null
    ? `step ${idx}${total != null ? '/' + total : ''}${title ? ` 「${title}」` : ''}`
    : '下一步';
  const lines = [
    '## [DISPATCH_NEXT_STEP] 上一步已通过——请派发下一步（不要 wait）',
    `计划尚未完成：${label} **尚未派发**，且当前没有在途的主 AI 任务。`,
    '**本轮必须用 `dispatch_to_main_ai` 派发它**（带 objective + acceptanceCriteria），不要 emit_action(wait)。',
    '**派发指令(prompt)要短**：一两句话点明这一步要做什么 + 引用步号/验收标准即可，不要把整步内容大段重述进 prompt'
      + '（主 AI 已能看到计划与验收标准）。prompt 过长会让本轮工具调用的 JSON 被截断、派发失败。',
    '这是"首次派单(dispatch)"而非"推进(advance)"——它从未派发过，不需要也等不到它的 turn_report 才派。',
  ];
  if (Array.isArray(ns.acceptanceCriteria) && ns.acceptanceCriteria.length > 0) {
    lines.push('该步验收标准（派单时带给主 AI，之后据此 Read 真实产物核验）：');
    for (const c of ns.acceptanceCriteria) lines.push(`  - ${c}`);
  }
  return lines;
}

function formatComposite(p, elapsed) {
  const events = Array.isArray(p.events) ? p.events : [];
  const nextStep = (p.nextStepToDispatch && typeof p.nextStepToDispatch === 'object')
    ? p.nextStepToDispatch : null;
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
    if (nextStep) {
      // Post-approve wake with an undispatched next step: dispatch, do NOT wait.
      lines.push(...buildNextStepDispatchLines(nextStep));
    } else if (dropped > 0) {
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
  if (nextStep) {
    // A next TODO step is already waiting to be dispatched (e.g. you approved the
    // previous step). Once you finish handling the events above, dispatch it.
    sections.push('', ...buildNextStepDispatchLines(nextStep));
  }
  return sections.join('\n');
}

function formatUserInput(p, elapsed) {
  const text = (p.text || '').trim();
  const head = p.planningRequired ? PLANNING_DIRECTIVE_LINES : [];
  return [
    ...head,
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
  const head = p.planningRequired ? PLANNING_DIRECTIVE_LINES : [];
  return [
    ...head,
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
