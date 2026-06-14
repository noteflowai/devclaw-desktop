export const CoworkActivitySidebarMode = {
  Overview: 'overview',
  RuntimeMonitor: 'runtime_monitor',
  LiveCode: 'live_code',
  CodeDiff: 'code_diff',
  OpenSquillaConsole: 'opensquilla_console',
} as const;
export type CoworkActivitySidebarMode = typeof CoworkActivitySidebarMode[keyof typeof CoworkActivitySidebarMode];

export const ActivitySidebarOpenSource = {
  AutoCodeChange: 'auto_code_change',
  LiveFile: 'live_file',
  ManualOpen: 'manual_open',
  DiffClick: 'diff_click',
} as const;
export type ActivitySidebarOpenSource = typeof ActivitySidebarOpenSource[keyof typeof ActivitySidebarOpenSource];
