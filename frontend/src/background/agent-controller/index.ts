/**
 * Agent Controller module root — re-exports the real implementation
 * (PRD 6.5). SW wiring lives in service-worker.ts via buildWiring().
 */
export { AgentController } from "./controller.js";
export type { ControllerDeps, PageSnapshotLike } from "./controller.js";
