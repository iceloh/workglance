// The system's own "choose a folder" window, opened by the local server for Settings (untrack a folder).
// The server runs on the user's machine, in their session, so it can show the native dialog the browser can't.
import { spawn } from "node:child_process";

/**
 * Windows: the modern Explorer folder picker (IFileOpenDialog with FOS_PICKFOLDERS), owned by an invisible
 * topmost window so it opens in front of the browser. Windows PowerShell's FolderBrowserDialog is the old tree.
 */
const WINDOWS = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogCom {}
[ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShellItem {
  void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
  void GetParent(out IShellItem item);
  void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
  void GetAttributes(uint mask, out uint attribs);
  void Compare(IShellItem item, uint hint, out int order);
}
[ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IFileDialog {
  [PreserveSig] int Show(IntPtr parent);
  void SetFileTypes(uint count, IntPtr specs);
  void SetFileTypeIndex(uint index);
  void GetFileTypeIndex(out uint index);
  void Advise(IntPtr events, out uint cookie);
  void Unadvise(uint cookie);
  void SetOptions(uint options);
  void GetOptions(out uint options);
  void SetDefaultFolder(IShellItem item);
  void SetFolder(IShellItem item);
  void GetFolder(out IShellItem item);
  void GetCurrentSelection(out IShellItem item);
  void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
  void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
  void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
  void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
  void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
  void GetResult(out IShellItem item);
}
public static class WorkglancePicker {
  public static string Pick(string title, IntPtr owner) {
    var d = (IFileDialog)new FileOpenDialogCom();
    uint o; d.GetOptions(out o); d.SetOptions(o | 0x20 | 0x40); // FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM
    d.SetTitle(title);
    int hr = d.Show(owner);
    if (hr == unchecked((int)0x800704C7)) return null;            // ERROR_CANCELLED: the user closed it
    if (hr != 0) throw new COMException("folder picker", hr);
    IShellItem item; d.GetResult(out item);
    string path; item.GetDisplayName(0x80058000, out path);        // SIGDN_FILESYSPATH
    return path;
  }
}
'@
# Started hidden (windowsHide), Windows applies "hide" to the process's first shown window: spend it on a
# throwaway form, or the owner (and the picker with it) never shows.
$spent = New-Object System.Windows.Forms.Form
$spent.ShowInTaskbar = $false; $spent.Opacity = 0; $spent.Show(); $spent.Close()
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.Opacity = 0; $owner.StartPosition = 'CenterScreen'
$owner.Show(); $owner.Activate()
$p = [WorkglancePicker]::Pick('Workglance: choose a folder to untrack', $owner.Handle)
$owner.Close()
if ($p) { [Console]::Out.Write($p) }
`;

/** Pure: how to open the folder picker on this platform; several candidates on Linux (whichever is installed). */
export function pickerCommands(platform: string): { cmd: string; args: string[] }[] {
  if (platform === "win32") {
    // As -EncodedCommand: nothing in it is parsed by a shell, and no user text goes in.
    return [{ cmd: "powershell.exe", args: ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(WINDOWS, "utf16le").toString("base64")] }];
  }
  if (platform === "darwin") return [{ cmd: "osascript", args: ["-e", 'POSIX path of (choose folder with prompt "Workglance: choose a folder to untrack")'] }];
  return [
    { cmd: "zenity", args: ["--file-selection", "--directory", "--title=Workglance: choose a folder to untrack"] },
    { cmd: "kdialog", args: ["--getexistingdirectory", ".", "--title", "Workglance: choose a folder to untrack"] },
  ];
}

export type Picked = { path: string } | { cancelled: true } | { unavailable: true };

/** Pure: a picker's exit read as a choice, a cancel, or "this picker isn't there". */
export function readPick(code: number | null, stdout: string, spawnFailed: boolean): Picked {
  if (spawnFailed) return { unavailable: true };
  const raw = stdout.trim();
  // macOS ends folders with "/"; keep it only on a root ("/", "C:\").
  const path = /^([a-zA-Z]:)?[\\/]$/.test(raw) ? raw : raw.replace(/[\\/]+$/, "");
  return code === 0 && path ? { path } : { cancelled: true };
}

let open: Promise<Picked> | null = null;

/** Opens the system folder picker and waits for the user (one at a time; a second click joins the first). */
export function pickFolder(platform: string = process.platform, timeoutMs = 10 * 60_000): Promise<Picked> {
  if (open) return open;
  const run = async (): Promise<Picked> => {
    for (const { cmd, args } of pickerCommands(platform)) {
      const r = await new Promise<Picked>((resolve) => {
        let out = "", failed = false;
        const p = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
        const timer = setTimeout(() => p.kill(), timeoutMs);
        p.stdout.on("data", (c) => (out += c));
        p.on("error", () => { failed = true; });
        p.on("close", (code) => { clearTimeout(timer); resolve(readPick(code, out, failed)); });
      });
      if (!("unavailable" in r)) return r;
    }
    return { unavailable: true };
  };
  open = run().finally(() => { open = null; });
  return open;
}
