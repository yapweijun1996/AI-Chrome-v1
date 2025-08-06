export enum NativeMessageType {
  START = 'start',
  STARTED = 'started',
  STOP = 'stop',
  STOPPED = 'stopped',
  PING = 'ping',
  PONG = 'pong',
  ERROR = 'error',
  PROCESS_DATA = 'process_data',
  PROCESS_DATA_RESPONSE = 'process_data_response',
  CALL_TOOL = 'call_tool',
  CALL_TOOL_RESPONSE = 'call_tool_response',
  // Additional message types used in Chrome extension
  SERVER_STARTED = 'server_started',
  SERVER_STOPPED = 'server_stopped',
  ERROR_FROM_NATIVE_HOST = 'error_from_native_host',
  CONNECT_NATIVE = 'connectNative',
  PING_NATIVE = 'ping_native',
  DISCONNECT_NATIVE = 'disconnect_native',
}

export interface NativeMessage<P = any, E = any> {
  type?: NativeMessageType;
  responseToRequestId?: string;
  payload?: P;
  error?: E;
}

// Workflow orchestration types
export interface WorkflowStep {
  id: string;
  tool: string;
  args: Record<string, any>;
  depends?: string[];
  condition?: string;
  onError?: 'fail' | 'retry' | 'continue' | 'rollback';
  retryCount?: number;
  retryDelay?: number;
  timeout?: number;
  waitFor?: WaitCondition;
}

export interface WaitCondition {
  type: 'element' | 'network_idle' | 'navigation' | 'custom';
  selector?: string;
  state?: 'visible' | 'hidden' | 'clickable' | 'text_matches';
  text?: string;
  url?: string;
  javascript?: string;
  timeout?: number;
  interval?: number;
}

export interface WorkflowDefinition {
  name: string;
  description?: string;
  steps: WorkflowStep[];
  variables?: Record<string, any>;
  errorHandling?: {
    strategy?: 'fail_fast' | 'continue_on_error' | 'rollback_on_error';
    rollbackSteps?: string[];
  };
}

export interface WorkflowTemplate {
  name: string;
  description?: string;
  workflow: WorkflowDefinition;
  category?: string;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface WorkflowExecution {
  id: string;
  workflow: WorkflowDefinition;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startTime: number;
  endTime?: number;
  currentStep?: string;
  completedSteps: string[];
  failedSteps: string[];
  variables: Record<string, any>;
  results: Record<string, any>;
  errors: Array<{
    stepId: string;
    error: string;
    timestamp: number;
    retryAttempt?: number;
  }>;
}

export interface WorkflowStepResult {
  stepId: string;
  success: boolean;
  result?: any;
  error?: string;
  executionTime: number;
  retryAttempt?: number;
}
