/**
 * Claude channel command handler – isolates all Claude specific command logic
 * away from the shared channel-manager entry point.
 */
import {
  sendMessage as claudeSendMessage,
  sendMessageWithAttachments as claudeSendMessageWithAttachments,
  rewindFiles as claudeRewindFiles,
  getMcpServerStatus as claudeGetMcpServerStatus,
  getMcpServerTools as claudeGetMcpServerTools
} from '../services/claude/message-service.js';
import {
  resetRuntimePersistent as claudeResetRuntimePersistent
} from '../services/claude/persistent-query-service.js';
import {
  getSessionMessages as claudeGetSessionMessages,
  getLatestUserMessage as claudeGetLatestUserMessage
} from '../services/claude/session-service.js';

/**
 * Execute a Claude specific command.
 * @param {string} command
 * @param {string[]} args
 * @param {object|null} stdinData
 */
export async function handleClaudeCommand(command, args, stdinData) {
  switch (command) {
    case 'send': {
      if (stdinData && stdinData.message !== undefined) {
        const { message, sessionId, cwd, permissionMode, model, openedFiles, agentPrompt, streaming, disableThinking, reasoningEffort } = stdinData;
        console.log(`[REASONING_EFFORT] claude-channel.send received: ${JSON.stringify({ reasoningEffort: reasoningEffort ?? null, model: model ?? null })}`);
        await claudeSendMessage(
          message,
          sessionId || '',
          cwd || '',
          permissionMode || '',
          model || '',
          openedFiles || null,
          agentPrompt || null,
          streaming,
          disableThinking || false,
          reasoningEffort || null
        );
      } else {
        await claudeSendMessage(args[0], args[1], args[2], args[3], args[4]);
      }
      break;
    }

    case 'sendWithAttachments': {
      if (stdinData && stdinData.message !== undefined) {
        const { message, sessionId, cwd, permissionMode, model, attachments, openedFiles, agentPrompt, streaming, reasoningEffort } = stdinData;
        console.log(`[REASONING_EFFORT] claude-channel.sendWithAttachments received: ${JSON.stringify({ reasoningEffort: reasoningEffort ?? null, model: model ?? null })}`);
        await claudeSendMessageWithAttachments(
          message,
          sessionId || '',
          cwd || '',
          permissionMode || '',
          model || '',
          attachments
            ? { attachments, openedFiles, agentPrompt, streaming, reasoningEffort }
            : { openedFiles, agentPrompt, streaming, reasoningEffort }
        );
      } else {
        await claudeSendMessageWithAttachments(args[0], args[1], args[2], args[3], args[4], stdinData);
      }
      break;
    }

    case 'getSession':
      await claudeGetSessionMessages(args[0], args[1]);
      break;

    case 'getLatestUserMessage':
      await claudeGetLatestUserMessage(args[0], args[1]);
      break;

    case 'rewindFiles': {
      const sessionId = stdinData?.sessionId || args[0];
      const userMessageId = stdinData?.userMessageId || args[1];
      const cwd = stdinData?.cwd || args[2] || null;
      if (!sessionId || !userMessageId) {
        console.log(JSON.stringify({
          success: false,
          error: 'Missing required parameters: sessionId and userMessageId'
        }));
        return;
      }
      await claudeRewindFiles(sessionId, userMessageId, cwd);
      break;
    }

    case 'getMcpServerStatus': {
      const cwd = stdinData?.cwd || args[0] || null;
      await claudeGetMcpServerStatus(cwd);
      break;
    }

    case 'getMcpServerTools': {
      const serverId = stdinData?.serverId || args[0] || null;
      await claudeGetMcpServerTools(serverId);
      break;
    }

    case 'resetRuntime': {
      await claudeResetRuntimePersistent(stdinData || {});
      break;
    }

    default:
      throw new Error(`Unknown Claude command: ${command}`);
  }
}

export function getClaudeCommandList() {
  return ['send', 'sendWithAttachments', 'getSession', 'getLatestUserMessage', 'rewindFiles', 'getMcpServerStatus', 'getMcpServerTools', 'resetRuntime'];
}
