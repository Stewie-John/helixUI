// Gemini Response Handler - JSON Stream processing
class GeminiResponseHandler {
  constructor(ws, options = {}) {
    this.ws = ws;
    this.buffer = '';
    this.onContentFragment = options.onContentFragment || null;
    this.onInit = options.onInit || null;
    this.onToolUse = options.onToolUse || null;
    this.onToolResult = options.onToolResult || null;
    this.getTokenUsage = typeof options.getTokenUsage === 'function' ? options.getTokenUsage : () => ({});
  }

  withTokenUsage(data = {}) {
    const usage = this.getTokenUsage() || {};
    const inputTokens = Number(usage.inputTokens || 0);
    const outputTokens = Number(usage.outputTokens || 0);
    const tokens = Number(data.tokens || usage.tokens || inputTokens + outputTokens || 0);
    return {
      ...data,
      tokens,
      inputTokens,
      outputTokens,
      total: Number(data.total || usage.total || 1000000),
      startedAt: usage.startedAt
    };
  }

  // Process incoming raw data from Gemini stream-json
  processData(data) {
    this.buffer += data;

    // Split by newline
    const lines = this.buffer.split('\n');

    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const event = JSON.parse(line);
        this.handleEvent(event);
      } catch (err) {
        // Not a JSON line, probably debug output or CLI warnings
        // console.error('[Gemini Handler] Non-JSON line ignored:', line);
      }
    }
  }

  handleEvent(event) {
    const socketSessionId = typeof this.ws.getSessionId === 'function' ? this.ws.getSessionId() : null;

    if (event.type === 'init') {
      if (this.onInit) {
        this.onInit(event);
      }
      return;
    }

    if (event.type === 'message' && event.role === 'assistant') {
      const content = event.content || '';

      // Notify the parent CLI handler of accumulated text
      if (this.onContentFragment && content) {
        this.onContentFragment(content);
      }

      let payload = {
        type: 'gemini-response',
        data: {
          type: 'message',
          content: content,
          isPartial: event.delta === true
        }
      };
      if (socketSessionId) payload.sessionId = socketSessionId;

      let statusPayload = {
        type: 'claude-status',
        data: this.withTokenUsage({
          status: 'Gemini writing response',
          can_interrupt: true
        }),
        provider: 'gemini'
      };
      if (socketSessionId) statusPayload.sessionId = socketSessionId;
      this.ws.send(statusPayload);

      this.ws.send(payload);
    }
    else if (event.type === 'tool_use') {
      if (this.onToolUse) {
        this.onToolUse(event);
      }
      let payload = {
        type: 'gemini-tool-use',
        toolName: event.tool_name,
        toolId: event.tool_id,
        parameters: event.parameters || {}
      };
      if (socketSessionId) payload.sessionId = socketSessionId;

      let statusPayload = {
        type: 'claude-status',
        data: this.withTokenUsage({
          status: `Gemini using ${event.tool_name || 'tool'}`,
          can_interrupt: true
        }),
        provider: 'gemini'
      };
      if (socketSessionId) statusPayload.sessionId = socketSessionId;
      this.ws.send(statusPayload);

      this.ws.send(payload);
    }
    else if (event.type === 'tool_result') {
      if (this.onToolResult) {
        this.onToolResult(event);
      }
      let payload = {
        type: 'gemini-tool-result',
        toolId: event.tool_id,
        status: event.status,
        output: event.output || ''
      };
      if (socketSessionId) payload.sessionId = socketSessionId;
      this.ws.send(payload);
    }
    else if (event.type === 'result') {
      // Send a finalize message string
      let payload = {
        type: 'gemini-response',
        data: {
          type: 'message',
          content: '',
          isPartial: false
        }
      };
      if (socketSessionId) payload.sessionId = socketSessionId;
      this.ws.send(payload);

      if (event.stats && event.stats.total_tokens) {
        let statsPayload = {
          type: 'claude-status',
          data: this.withTokenUsage({
            status: 'Complete',
            tokens: event.stats.total_tokens
          })
        };
        if (socketSessionId) statsPayload.sessionId = socketSessionId;
        this.ws.send(statsPayload);
      }
    }
    else if (event.type === 'error') {
      let payload = {
        type: 'gemini-error',
        error: event.error || event.message || 'Unknown Gemini streaming error'
      };
      if (socketSessionId) payload.sessionId = socketSessionId;
      this.ws.send(payload);
    }
  }

  forceFlush() {
    // If the buffer has content, try to parse it one last time
    if (this.buffer.trim()) {
      try {
        const event = JSON.parse(this.buffer);
        this.handleEvent(event);
      } catch (err) { }
    }
  }

  destroy() {
    this.buffer = '';
  }
}

export default GeminiResponseHandler;
