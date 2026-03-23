/**
 * Native Runner for NanoClaw
 * Runs the agent-runner as a direct child process (no container).
 * Used when NATIVE_MODE=true (e.g., Railway deployment).
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  GROUPS_DIR,
  TIMEZONE,
} from './config.js';
import {
  ContainerInput,
  ContainerOutput,
  handleAgentProcess,
} from './container-runner.js';
import { detectAuthMode } from './credential-proxy.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export async function runNativeAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, processName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });

  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });

  // Pre-configure Claude CLI to skip first-run wizard
  const userSettingsFile = path.join(groupSessionsDir, 'user_settings.json');
  if (!fs.existsSync(userSettingsFile)) {
    fs.writeFileSync(
      userSettingsFile,
      JSON.stringify({
        theme: 'dark',
        hasCompletedOnboarding: true,
        hasAcknowledgedDisclaimer: true,
      }),
    );
  }

  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }

  const globalDir = path.join(GROUPS_DIR, 'global');

  // Resolve additional mount directories for WORKSPACE_EXTRA
  let extraDir: string | undefined;
  if (group.containerConfig?.additionalMounts) {
    const extraBase = path.join(DATA_DIR, 'extra', group.folder);
    fs.mkdirSync(extraBase, { recursive: true });
    for (const mount of group.containerConfig.additionalMounts) {
      const hostPath = mount.hostPath.replace(/^~/, process.env.HOME || '');
      const name = mount.containerPath || path.basename(hostPath);
      const linkPath = path.join(extraBase, name);
      try {
        if (fs.existsSync(linkPath)) fs.unlinkSync(linkPath);
        fs.symlinkSync(hostPath, linkPath);
      } catch (err) {
        logger.warn(
          { hostPath, linkPath, err },
          'Failed to create symlink for extra mount',
        );
      }
    }
    extraDir = extraBase;
  }

  const agentRunnerDist = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'dist',
    'index.js',
  );
  if (!fs.existsSync(agentRunnerDist)) {
    throw new Error(
      `Agent runner not compiled: ${agentRunnerDist} not found. Run: cd container/agent-runner && npm run build`,
    );
  }

  const homeDir = path.join(DATA_DIR, 'sessions', group.folder);

  // Route API calls through the credential proxy (same as container mode).
  // The proxy injects real credentials; the agent only sees placeholders.
  const authMode = detectAuthMode();

  const env: Record<string, string> = {
    TZ: TIMEZONE,
    HOME: homeDir,
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    NANOCLAW_WORKSPACE_GROUP: groupDir,
    NANOCLAW_WORKSPACE_IPC: groupIpcDir,
    NANOCLAW_WORKSPACE_GLOBAL: globalDir,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${CREDENTIAL_PROXY_PORT}`,
  };

  // Mirror host auth mode with placeholder values (proxy injects real ones)
  if (authMode === 'api-key') {
    env.ANTHROPIC_API_KEY = 'placeholder';
  } else {
    env.CLAUDE_CODE_OAUTH_TOKEN = 'placeholder';
  }

  if (extraDir) {
    env.NANOCLAW_WORKSPACE_EXTRA = extraDir;
  }

  // Pass through NODE_ENV if set
  if (process.env.NODE_ENV) {
    env.NODE_ENV = process.env.NODE_ENV;
  }

  // Pass through MCP server credentials
  if (process.env.GITHUB_PERSONAL_ACCESS_TOKEN) {
    env.GITHUB_PERSONAL_ACCESS_TOKEN = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  }
  if (process.env.LINEAR_API_KEY) {
    env.LINEAR_API_KEY = process.env.LINEAR_API_KEY;
  }

  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const processName = `nanoclaw-native-${safeName}-${Date.now()}`;

  logger.info(
    {
      group: group.name,
      processName,
      isMain: input.isMain,
      home: homeDir,
      groupDir,
    },
    'Spawning native agent',
  );

  const proc = spawn('node', [agentRunnerDist], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
    cwd: groupDir,
  });

  return handleAgentProcess(
    proc,
    processName,
    group,
    input,
    onProcess,
    onOutput,
    (_name: string) => {
      try {
        proc.kill('SIGTERM');
        setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            /* already dead */
          }
        }, 5000);
      } catch {
        /* already dead */
      }
    },
  );
}
