export {
	FakeExecProvider,
	FULL_EXEC_CAPABILITIES,
} from "../adapters/fake/fake-exec-provider.ts";
export type {
	FakeExecProviderOptions,
	FakeExecution,
} from "../adapters/fake/fake-exec-provider.ts";
export { FakeHarnessAdapter } from "../adapters/fake/fake-harness-adapter.ts";
export { FakeSurfaceProvider } from "../surfaces/fake/fake-surface-provider.ts";
export * from "./exec-provider.conformance.ts";
export * from "./harness-adapter.conformance.ts";
export * from "./surface-provider.conformance.ts";
