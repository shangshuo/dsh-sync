/**
 * Native file/folder picker for the settings page.
 *
 * The Host runs as a plain Node process, so there is no Electron dialog to borrow.
 * Each platform gets its own small bridge; a missing helper returns a clear error
 * instead of silently doing nothing.
 */
import { spawn } from 'node:child_process';

import { t } from './i18n.js';

const TIMEOUT_MS = 5 * 60 * 1000;

/** @param {string} command @param {string[]} args */
function run(command, args) {
  return new Promise((resolve) => {
    /** @type {import('node:child_process').ChildProcessWithoutNullStreams} */
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error?.message ?? error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: -2, stdout: '', stderr: t('选择窗口超时') });
    }, TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: '', stderr: String(error?.message ?? error) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** @param {string} script */
function encodePowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** @param {'file'|'folder'} kind */
function windowsScript(kind) {
  const dialog =
    kind === 'folder'
      ? `$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择包含 DSH 快照的文件夹'
$dialog.ShowNewFolderButton = $false`
      : `$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = '选择 DSH 快照文件'
$dialog.Filter = 'DSH 快照 (*.dshsync)|*.dshsync|所有文件 (*.*)|*.*'
$dialog.CheckFileExists = $true`;
  const result = kind === 'folder' ? '$dialog.SelectedPath' : '$dialog.FileName';
  return `Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null
${dialog}
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = 'None'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0
$owner.Show()
try {
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Out.Write(${result})
  }
} finally {
  $owner.Close()
  $owner.Dispose()
}`;
}

/**
 * @param {'file'|'folder'} kind
 * @returns {Promise<{ path: string | null, message?: string }>}
 */
export async function pickPath(kind) {
  const wanted = kind === 'folder' ? 'folder' : 'file';
  if (process.platform === 'win32') {
    const result = await run('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', encodePowerShell(windowsScript(wanted))]);
    if (result.code === -2) return { path: null, message: result.stderr };
    const picked = result.stdout.trim();
    if (picked) return { path: picked };
    if (result.stderr.trim()) return { path: null, message: result.stderr.trim() };
    return { path: null };
  }
  if (process.platform === 'darwin') {
    const script =
      wanted === 'folder'
        ? 'POSIX path of (choose folder with prompt "选择包含 DSH 快照的文件夹")'
        : 'POSIX path of (choose file with prompt "选择 DSH 快照文件")';
    const result = await run('osascript', ['-e', script]);
    if (result.code === 0 && result.stdout.trim()) return { path: result.stdout.trim() };
    return { path: null };
  }
  const args = wanted === 'folder' ? ['--file-selection', '--directory', '--title=选择包含 DSH 快照的文件夹'] : ['--file-selection', '--title=选择 DSH 快照文件'];
  const zenity = await run('zenity', args);
  if (zenity.code === 0 && zenity.stdout.trim()) return { path: zenity.stdout.trim() };
  if (zenity.code !== -1) return { path: null };
  const kdialogArgs =
    wanted === 'folder' ? ['--getexistingdirectory', process.env.HOME ?? '.'] : ['--getopenfilename', process.env.HOME ?? '.', '*.dshsync|DSH 快照'];
  const kdialog = await run('kdialog', kdialogArgs);
  if (kdialog.code === 0 && kdialog.stdout.trim()) return { path: kdialog.stdout.trim() };
  return { path: null, message: t('当前系统没有可用的文件选择器（zenity/kdialog），请手动填写路径。') };
}
