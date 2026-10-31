import { execFileSync } from 'node:child_process';
import { soundCommand } from '../agent/extensions/notify.ts';

const { command, args, options } = soundCommand();
execFileSync(command, args, { ...options, stdio: 'inherit' });
