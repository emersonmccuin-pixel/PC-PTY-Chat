export interface DevStatus {
  activeAgents: number;
  canRestart: boolean;
  /** TEMP reload-test marker emitted by the BE; absent until the server is
   *  restarted onto the new source. Remove after testing. */
  marker?: string;
}
