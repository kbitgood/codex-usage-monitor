export interface UsageNumbers {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

export interface RateLimitWindow {
  used_percent: number;
  window_minutes: number;
  resets_at: number;
}

export interface RateLimits {
  limit_id?: string;
  limit_name?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  plan_type?: string | null;
  rate_limit_reached_type?: string | null;
  credits?: {
    has_credits?: boolean;
    unlimited?: boolean;
    balance?: string | number | null;
  } | null;
}

export interface MonitorSnapshot {
  eventTimestamp: string;
  sourceFile: string;
  sessionId?: string;
  cwd?: string;
  cliVersion?: string;
  originator?: string;
  model?: string;
  effort?: string;
  totalUsage: UsageNumbers;
  lastUsage: UsageNumbers;
  contextWindow?: number;
  rateLimits: RateLimits;
}

export interface CreditDay {
  date: string;
  credits: number;
  partial: boolean;
  confirmedCredits?: number;
  boundaryCredits?: number;
  metadataReserve?: number;
  speedReserve?: number;
}

export interface CreditSnapshot {
  status: "ready" | "auth_required" | "unavailable" | "error";
  days: CreditDay[];
  source?: "admin" | "estimate";
  actualDays?: CreditDay[];
  estimatedDays?: CreditDay[];
  adminStatus?: "ready" | "auth_required" | "unavailable" | "error";
  updatedAt?: string;
  message?: string;
}

export interface ParsedEvent {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}
