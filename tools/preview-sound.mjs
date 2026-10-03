import { execFileSync } from 'node:child_process';
import { notificationCommand } from '../agent/extensions/notify.ts';

// Exercise the same toast and audio command as Pi, without a .ps1 dependency.
const { command, args, options } = notificationCommand();
execFileSync(command, args, { ...options, stdio: 'inherit' });
