export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

export type TelemetrySeverity = "debug" | "info" | "warning" | "error" | "critical";

export interface PiTelemetrySource {
	host_id: string;
	component: string;
	robot_id?: string;
	instance_id?: string;
	version?: string;
}

export interface PiTelemetryCorrelation {
	trace_id?: string;
	parent_id?: string;
	session_id?: string;
	conversation_id?: string;
	turn_id?: string;
	step_id?: string;
	request_id?: string;
	tool_call_id?: string;
	assignment_id?: string;
}

/** Source record accepted by UnifiedAgent telemetry ingest. */
export interface PiTelemetryRecord {
	kind: string;
	source: PiTelemetrySource;
	phase?: string;
	severity?: TelemetrySeverity;
	state?: string;
	summary?: string;
	correlation?: PiTelemetryCorrelation;
	duration_ms?: number;
	attributes?: { [key: string]: JsonValue };
	privacy_class?: string;
	payload_ref?: string;
}

export interface TelemetryAcknowledgement {
	accepted: boolean;
	event_id: string | null;
	sequence: number | null;
	error: string | null;
}

export type TelemetrySocketState =
	| "disconnected"
	| "connecting"
	| "connected"
	| "backoff"
	| "disposed";

export interface TelemetrySocketHealth {
	state: TelemetrySocketState;
	queued: number;
	queuedBytes: number;
	accepted: number;
	rejected: number;
	errors: number;
	gaps: number;
}
