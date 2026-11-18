import { spawn } from 'node:child_process';
import path from 'node:path';

const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';

function runStep(cmd, args, envPatch = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      env: { ...process.env, ...envPatch },
      shell: isWin,
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

console.log('Building frontend and Electron backend for desktop launch...');
await runStep(npmCmd, ['run', 'desktop:build']);

const electronBin = path.resolve(
  process.cwd(),
  'node_modules',
  '.bin',
  isWin ? 'electron.cmd' : 'electron'
);

console.log('Launching Visual Database Studio Desktop...');
await runStep(electronBin, ['.'], { VDS_ELECTRON_DEV: '0' });
