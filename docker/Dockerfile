FROM node:20-slim

# Create non-root user (uid alignment with host done at run-time via --user).
RUN useradd -m -u 1000 devuser

USER devuser
WORKDIR /home/devuser

# 1. Install Claude CLI / SDK (required for daemon to function).
#    - claude-code: the official CLI (used for `claude login` OAuth flow)
#    - claude-agent-sdk: the JS SDK the daemon imports at runtime (separate
#      package, not guaranteed to be hoisted from claude-code's deps)
RUN npm i -g @anthropic-ai/claude-code @anthropic-ai/claude-agent-sdk

# 2. (Optional) Pre-install commonly used MCP servers. Uncomment as needed.
# RUN npm i -g @modelcontextprotocol/server-github

# 3. Pre-place user config (build-time copy; can also be mounted at run-time).
#    Place these files alongside the Dockerfile before building, or skip and
#    inject at runtime via volume mounts.
# COPY --chown=devuser settings.json /home/devuser/.claude/settings.json
# COPY --chown=devuser claude.json   /home/devuser/.claude.json
# COPY --chown=devuser codemoss/     /home/devuser/.codemoss/

# 4. Install ai-bridge-server.
USER root
RUN mkdir -p /opt/ai-bridge-server && chown devuser:devuser /opt/ai-bridge-server
USER devuser
COPY --chown=devuser ../package.json ../package-lock.json* /opt/ai-bridge-server/
WORKDIR /opt/ai-bridge-server
RUN npm ci --omit=dev || npm install --omit=dev
COPY --chown=devuser ../src ./src
COPY --chown=devuser ../ai-bridge ./ai-bridge
COPY --chown=devuser ../scripts ./scripts
RUN chmod +x ./scripts/start.sh

EXPOSE 3284
ENV PORT=3284
ENV LOG_LEVEL=info
ENV SESSION_IDLE_TIMEOUT_MS=60000

# Use start.sh so NODE_PATH gets set from `npm root -g` at boot — lets the
# daemon resolve globally installed packages like @anthropic-ai/claude-agent-sdk.
CMD ["./scripts/start.sh"]
