import { spawn } from 'child_process';
import crossSpawn from 'cross-spawn';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

// Use cross-spawn on Windows for better command execution
const spawnFunction = process.platform === 'win32' ? crossSpawn : spawn;

let activeCursorProcesses = new Map(); // Track active processes by session ID

function imageExtensionFromMime(mimeType) {
    const subtype = String(mimeType || 'png').split('/')[1] || 'png';
    if (subtype === 'svg+xml') return 'svg';
    if (subtype === 'jpeg') return 'jpg';
    return subtype.replace(/[^a-z0-9]/gi, '') || 'png';
}

async function appendImagesToCommand(command, images, workingDir) {
    if (!images || images.length === 0) {
        return { command, tempDir: null };
    }

    try {
        const tempDir = path.join(workingDir, '.tmp', 'images', Date.now().toString());
        await fs.mkdir(tempDir, { recursive: true });

        const tempImagePaths = [];
        for (const [index, image] of images.entries()) {
            const matches = image?.data?.match(/^data:([^;]+);base64,(.+)$/);
            if (!matches) continue;

            const [, mimeType, base64Data] = matches;
            const filepath = path.join(tempDir, `image_${index}.${imageExtensionFromMime(mimeType)}`);
            await fs.writeFile(filepath, Buffer.from(base64Data, 'base64'));
            tempImagePaths.push(filepath);
        }

        if (tempImagePaths.length === 0) {
            return { command, tempDir };
        }

        const baseCommand = command && command.trim() ? command : 'Please analyze the attached image(s).';
        const imageNote = `\n\n[Images provided at the following paths:]\n${tempImagePaths.map((p, i) => `${i + 1}. ${p}`).join('\n')}`;
        return { command: baseCommand + imageNote, tempDir };
    } catch (error) {
        console.error('Error processing images for Cursor:', error);
        return { command, tempDir: null };
    }
}

function estimateTokenCount(text) {
    const value = String(text || '');
    if (!value) return 0;
    return Math.max(1, Math.ceil(value.length / 4));
}

async function spawnCursor(command, options = {}, ws) {
  return new Promise(async (resolve, reject) => {
    const { sessionId, projectPath, cwd, resume, toolsSettings, skipPermissions, model, images } = options;
    let capturedSessionId = sessionId; // Track session ID throughout the process
    let sessionCreatedSent = false; // Track if we've already sent session-created event
    let messageBuffer = ''; // Buffer for accumulating assistant messages
    const workingDir = cwd || projectPath || process.cwd();
    const imagePrompt = await appendImagesToCommand(command, images, workingDir);
    const finalCommand = imagePrompt.command;
    const startedAt = new Date().toISOString();
    const usageEstimate = {
      inputTokens: estimateTokenCount(finalCommand) + (Array.isArray(images) ? images.length * 256 : 0),
      outputTokens: 0
    };
    
    // Use tools settings passed from frontend, or defaults
    const settings = toolsSettings || {
      allowedShellCommands: [],
      skipPermissions: false
    };
    
    // Build Cursor CLI command
    const args = [];
    
    // Build flags allowing both resume and prompt together (reply in existing session)
    // Treat presence of sessionId as intention to resume, regardless of resume flag
    if (sessionId) {
      args.push('--resume=' + sessionId);
    }

    if (finalCommand && finalCommand.trim()) {
      // Provide a prompt (works for both new and resumed sessions)
      args.push('-p', finalCommand);

      // Add model flag if specified (only meaningful for new sessions; harmless on resume)
      if (!sessionId && model) {
        args.push('--model', model);
      }

      // Request streaming JSON when we are providing a prompt
      args.push('--output-format', 'stream-json');
    }
    
    // Add skip permissions flag if enabled
    if (skipPermissions || settings.skipPermissions) {
      args.push('-f');
      console.log('⚠️  Using -f flag (skip permissions)');
    }
    
    console.log('Spawning Cursor CLI:', 'cursor-agent', args.join(' '));
    console.log('Working directory:', workingDir);
    console.log('Session info - Input sessionId:', sessionId, 'Resume:', resume);
    
    const cursorProcess = spawnFunction('cursor-agent', args, {
      cwd: workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env } // Inherit all environment variables
    });
    cursorProcess.startedAt = startedAt;
    
    // Store process reference for potential abort
    const processKey = capturedSessionId || Date.now().toString();
    activeCursorProcesses.set(processKey, cursorProcess);

    const sendCursorStatus = (status) => {
      ws.send({
        type: 'claude-status',
        data: {
          status,
          tokens: usageEstimate.inputTokens + usageEstimate.outputTokens,
          inputTokens: usageEstimate.inputTokens,
          outputTokens: usageEstimate.outputTokens,
          total: 200000,
          startedAt,
          can_interrupt: true
        },
        sessionId: capturedSessionId || sessionId || processKey,
        provider: 'cursor'
      });
    };

    sendCursorStatus('Starting Cursor');
    
    // Handle stdout (streaming JSON responses)
    cursorProcess.stdout.on('data', (data) => {
      const rawOutput = data.toString();
      console.log('📤 Cursor CLI stdout:', rawOutput);
      
      const lines = rawOutput.split('\n').filter(line => line.trim());
      
      for (const line of lines) {
        try {
          const response = JSON.parse(line);
          console.log('📄 Parsed JSON response:', response);
          
          // Handle different message types
          switch (response.type) {
            case 'system':
              if (response.subtype === 'init') {
                // Capture session ID
                if (response.session_id && !capturedSessionId) {
                  capturedSessionId = response.session_id;
                  console.log('📝 Captured session ID:', capturedSessionId);
                  
                  // Update process key with captured session ID
                  if (processKey !== capturedSessionId) {
                    activeCursorProcesses.delete(processKey);
                    activeCursorProcesses.set(capturedSessionId, cursorProcess);
                  }
                  
                  // Set session ID on writer (for API endpoint compatibility)
                  if (ws.setSessionId && typeof ws.setSessionId === 'function') {
                    ws.setSessionId(capturedSessionId);
                  }

                  // Send session-created event only once for new sessions
                  if (!sessionId && !sessionCreatedSent) {
                    sessionCreatedSent = true;
                    ws.send({
                      type: 'session-created',
                      sessionId: capturedSessionId,
                      provider: 'cursor',
                      model: response.model,
                      cwd: response.cwd
                    });
                  }
                }
                
                // Send system info to frontend
                ws.send({
                  type: 'cursor-system',
                  data: response,
                  sessionId: capturedSessionId || sessionId || null
                });

                sendCursorStatus('Cursor working');
              }
              break;
              
            case 'user':
              // Forward user message
              ws.send({
                type: 'cursor-user',
                data: response,
                sessionId: capturedSessionId || sessionId || null
              });
              break;
              
            case 'assistant':
              // Accumulate assistant message chunks
              if (response.message && response.message.content && response.message.content.length > 0) {
                const textContent = response.message.content[0].text;
                messageBuffer += textContent;
                usageEstimate.outputTokens = Math.max(usageEstimate.outputTokens, estimateTokenCount(messageBuffer));

                sendCursorStatus('Cursor writing response');
                
                // Send as Claude-compatible format for frontend
                ws.send({
                  type: 'claude-response',
                  data: {
                    type: 'content_block_delta',
                    delta: {
                      type: 'text_delta',
                      text: textContent
                    }
                  },
                  sessionId: capturedSessionId || sessionId || null
                });
              }
              break;
              
            case 'result':
              // Session complete
              console.log('Cursor session result:', response);
              
              // Send final message if we have buffered content
              if (messageBuffer) {
                ws.send({
                  type: 'claude-response',
                  data: {
                    type: 'content_block_stop'
                  },
                  sessionId: capturedSessionId || sessionId || null
                });
              }
              
              // Send completion event
              ws.send({
                type: 'cursor-result',
                sessionId: capturedSessionId || sessionId,
                data: response,
                success: response.subtype === 'success'
              });
              break;
              
            default:
              // Forward any other message types
              ws.send({
                type: 'cursor-response',
                data: response,
                sessionId: capturedSessionId || sessionId || null
              });
          }
        } catch (parseError) {
          console.log('📄 Non-JSON response:', line);
          // If not JSON, send as raw text
          ws.send({
            type: 'cursor-output',
            data: line,
            sessionId: capturedSessionId || sessionId || null
          });
        }
      }
    });
    
    // Handle stderr
    cursorProcess.stderr.on('data', (data) => {
      console.error('Cursor CLI stderr:', data.toString());
      ws.send({
        type: 'cursor-error',
        error: data.toString(),
        sessionId: capturedSessionId || sessionId || null
      });
    });
    
    // Handle process completion
    cursorProcess.on('close', async (code) => {
      console.log(`Cursor CLI process exited with code ${code}`);
      if (imagePrompt.tempDir) {
        await fs.rm(imagePrompt.tempDir, { recursive: true, force: true }).catch(() => {});
      }
      
      // Clean up process reference
      const finalSessionId = capturedSessionId || sessionId || processKey;
      activeCursorProcesses.delete(finalSessionId);

      ws.send({
        type: 'claude-complete',
        sessionId: finalSessionId,
        exitCode: code,
        isNewSession: !sessionId && !!finalCommand // Flag to indicate this was a new session
      });
      
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Cursor CLI exited with code ${code}`));
      }
    });
    
    // Handle process errors
    cursorProcess.on('error', (error) => {
      console.error('Cursor CLI process error:', error);
      if (imagePrompt.tempDir) {
        void fs.rm(imagePrompt.tempDir, { recursive: true, force: true }).catch(() => {});
      }
      
      // Clean up process reference on error
      const finalSessionId = capturedSessionId || sessionId || processKey;
      activeCursorProcesses.delete(finalSessionId);

      ws.send({
        type: 'cursor-error',
        error: error.message,
        sessionId: capturedSessionId || sessionId || null
      });

      reject(error);
    });
    
    // Close stdin since Cursor doesn't need interactive input
    cursorProcess.stdin.end();
  });
}

function abortCursorSession(sessionId) {
  const process = activeCursorProcesses.get(sessionId);
  if (process) {
    console.log(`🛑 Aborting Cursor session: ${sessionId}`);
    process.kill('SIGTERM');
    activeCursorProcesses.delete(sessionId);
    return true;
  }
  return false;
}

function isCursorSessionActive(sessionId) {
  return activeCursorProcesses.has(sessionId);
}

function getActiveCursorSessions() {
  return Array.from(activeCursorProcesses.entries()).map(([id, process]) => ({
    id,
    status: 'running',
    startedAt: process.startedAt || null
  }));
}

function getCursorSessionInfo(sessionId) {
  const process = activeCursorProcesses.get(sessionId);
  if (!process) return null;
  return {
    id: sessionId,
    status: 'running',
    startedAt: process.startedAt || null
  };
}

export {
  spawnCursor,
  abortCursorSession,
  isCursorSessionActive,
  getCursorSessionInfo,
  getActiveCursorSessions
};
