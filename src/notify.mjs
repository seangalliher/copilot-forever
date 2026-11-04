// Desktop notification per OS. Every notification is also logged, so a missing notifier
// (no desktop session, notify-send not installed) loses nothing.
import { run } from './proc.mjs';

const xmlEscape = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
const psSingle = (s) => String(s).replace(/'/g, "''");
const appleQuote = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

/**
 * Build the per-OS command; exported for tests.
 * @returns {[string, string[]] | null}
 */
export function notifyCommand(platform, title, body) {
  if (platform === 'win32') {
    // Windows PowerShell 5.1 has the WinRT toast types (pwsh 7 does not). Shown under
    // Windows PowerShell's app id, which every Windows install registers.
    const xml = `<toast scenario="reminder"><visual><binding template="ToastGeneric"><text>${xmlEscape(title)}</text><text>${xmlEscape(body)}</text></binding></visual><actions><action content="Dismiss" arguments="dismiss" activationType="system"/></actions></toast>`;
    const script = [
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
      '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
      '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
      `$x.LoadXml('${psSingle(xml)}')`,
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($x))",
    ].join('\n');
    const enc = Buffer.from(script, 'utf16le').toString('base64');
    const ps = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    return [ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc]];
  }
  if (platform === 'darwin') return ['osascript', ['-e', `display notification ${appleQuote(body)} with title ${appleQuote(title)}`]];
  if (platform === 'linux') return ['notify-send', ['--app-name=copilot-forever', '--urgency=normal', title, body]];
  return null;
}

/** Show a notification; log it either way. Never throws. */
export async function notify(cfg, log, title, body, { dryRun = false } = {}) {
  log.info(`notify: ${title} — ${body}`);
  if (dryRun || !cfg.notify) return false;
  const c = notifyCommand(process.platform, title, body);
  if (!c) return false;
  try {
    const r = await run(c[0], c[1], { timeoutMs: 20000 });
    if (r.code !== 0) {
      log.warn(`desktop notification failed (${(r.stderr || r.error?.message || `exit ${r.code}`).trim().slice(0, 200)}); see the line above`);
      return false;
    }
    return true;
  } catch (e) {
    log.warn(`desktop notification failed (${e.message}); see the line above`);
    return false;
  }
}
