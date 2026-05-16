// GlobalSettings — app-level singleton (one row, id='global').

export interface GlobalSettings {
  /** Active data dir at last write. */
  dataDir: string;
  /** Telemetry opt-in. Default false. */
  telemetryOptIn: boolean;
}

/** Defaults for a fresh settings_global row. The DB seeder calls this with
 *  the launch-time data dir so domain stays I/O-free. */
export function defaultGlobalSettings(dataDir: string): GlobalSettings {
  return {
    dataDir,
    telemetryOptIn: false,
  };
}
