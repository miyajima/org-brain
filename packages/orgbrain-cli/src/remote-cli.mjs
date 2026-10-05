import { open } from 'node:fs/promises';
import { OrgBrainRemoteClient } from './remote-oauth-client.mjs';
import { RemotePrivateStore, defaultRemoteDirectory } from './lib/remote-private-store.mjs';
import { RemoteOAuthError, REMOTE_SCOPES } from './lib/remote-oauth-http.mjs';

async function explicitJson(filename) {
  if (!filename) throw new RemoteOAuthError('explicit_input_required');
  const file = await open(filename, 'r').catch(() => { throw new RemoteOAuthError('invalid_input_file'); });
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error();
    const buffer = Buffer.alloc(64 * 1024 + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 64 * 1024) throw new Error();
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } catch { throw new RemoteOAuthError('invalid_input_file'); }
  finally { await file.close(); }
}

export async function runRemoteCommand(action, rest, args) {
  // Unsupported options fail before authentication/network. No scope or identity
  // override exists for commands on a saved profile.
  const options = {
    login: ['--mcp-url', '--tenant-id', '--project-id', '--principal-id', '--mode', '--execute'],
    status: [], refresh: [], logout: [], search: ['--limit'],
    stage: ['--input', '--execute', '--expected-plan-hash'],
    'confirmation-status': ['--confirmation-token'], confirm: ['--input']
  };
  if (!Object.hasOwn(options, action)) throw new RemoteOAuthError('unknown_command');
  const allowed = new Set(['--remote-directory', '--profile', '--json', ...options[action]]);
  if (args.names().some(name => !allowed.has(name)) || args.ambiguousOptions() || action !== 'search' && rest.length) {
    throw new RemoteOAuthError('unsupported_option');
  }
  const directory = args.get('--remote-directory', defaultRemoteDirectory());
  const store = new RemotePrivateStore({ directory, profile: args.get('--profile', 'default') });
  const client = new OrgBrainRemoteClient({ store });
  if (action === 'login') {
    const binding = client.binding({ resource: args.get('--mcp-url'), tenant_id: args.get('--tenant-id'),
      project_id: args.get('--project-id'), principal: args.get('--principal-id') });
    const mode = args.get('--mode', 'loopback');
    if (!['loopback', 'device'].includes(mode)) throw new RemoteOAuthError('invalid_login_mode');
    if (!args.flags.has('--execute')) return { dry_run: true, ...binding, scopes: REMOTE_SCOPES,
      mode, credential_file: store.path, file_permission: '0600', directory_permission: '0700',
      requires_user_terminal: true, device_server_support_required: mode === 'device' };
    if (!process.stdin.isTTY || !process.stderr.isTTY) throw new RemoteOAuthError('user_terminal_required');
    return client.login(binding, { mode, onAuthorize: ({ url, user_code }) => {
      process.stderr.write(`Open this URL in your own browser:\n${url}\n`);
      if (user_code) process.stderr.write(`Enter this code on that page: ${user_code}\n`);
      process.stderr.write('Confirm the account and read/write permissions. Never paste callback URLs or tokens into chat.\n');
    } });
  }
  if (action === 'status') return client.status();
  if (action === 'refresh') return client.refresh();
  if (action === 'logout') return client.logout();
  if (action === 'search') return client.search(rest.join(' '), { limit: Number(args.get('--limit', '10')) });
  if (action === 'stage') return client.stage(await explicitJson(args.get('--input')), {
    execute: args.flags.has('--execute'), expectedPlanHash: args.get('--expected-plan-hash') });
  if (action === 'confirmation-status') return client.confirmationStatus(args.get('--confirmation-token'));
  if (action === 'confirm') return client.confirm(await explicitJson(args.get('--input')));
  throw new RemoteOAuthError('unknown_command');
}
