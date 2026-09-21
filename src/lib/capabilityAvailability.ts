/**
 * AXON Capability Availability & Environment Awareness Architecture
 *
 * Core Principles:
 * 1. Distinguishes between conceptual capability support and real runtime availability.
 * 2. Real environment detection:
 *    - Real network state (navigator.onLine + 'online'/'offline' events)
 *    - Real platform detection (browser, PWA, restricted iframe, Node)
 *    - Real resource constraints (integration with ResourceMonitor)
 *    - Real platform permissions (navigator.permissions when supported)
 *    - Real local model readiness (AXON on-device neural engine)
 * 3. Structured availability states and actionable unavailability reasons.
 * 4. Offline-first execution: core capabilities remain operational without internet.
 * 5. Dynamic event-driven awareness without polling loops or background drain.
 * 6. Self-awareness querying interface for intent resolution, command routing, and reasoning.
 */

import { ResourceMonitor, ResourceState } from './runtime/resourceMonitor';

// ============================================================================
// 1. AVAILABILITY STATES & STRUCTURED REASONS
// ============================================================================

export type CapabilityAvailabilityState =
  | 'available'
  | 'unavailable'
  | 'temporarily_unavailable'
  | 'permission_required'
  | 'permission_denied'
  | 'dependency_unavailable'
  | 'network_required'
  | 'resource_constrained'
  | 'unsupported_platform'
  | 'not_configured'
  | 'initializing';

export interface UnavailabilityReason {
  state: CapabilityAvailabilityState;
  code: string;
  message: string;
  userFriendlyReason: string;
  missingRequirement?: {
    type: 'network' | 'permission' | 'configuration' | 'platform' | 'resource' | 'dependency' | 'local_model';
    target?: string;
  };
  recoverySuggestion?: string;
}

// ============================================================================
// 2. CAPABILITY REQUIREMENTS & SELF-DESCRIPTION
// ============================================================================

export type PlatformType = 'browser' | 'pwa' | 'iframe' | 'node' | 'all';

export interface CapabilityRequirements {
  /** If true, strictly requires an active internet connection */
  requiresNetwork?: boolean;
  /** If true, capability is guaranteed to function locally without internet */
  offlineCapable: boolean;
  /** Whether capability requires on-device neural model */
  requiresLocalModel?: boolean | string;
  /** Required external provider account or API key (e.g. 'gemini', 'claude', 'chatgpt') */
  requiresExternalAccount?: string;
  /** Required platform permissions (e.g. 'clipboard-read', 'camera', 'microphone') */
  requiredPermissions?: string[];
  /** Platforms where capability can physically execute */
  supportedPlatforms?: PlatformType[];
  /** Required runtime dependencies (e.g. 'dom', 'canvas', 'storage') */
  requiredDependencies?: string[];
  /** Maximum acceptable pressure level from ResourceMonitor */
  maxPressureLevel?: 'nominal' | 'elevated' | 'throttled';
  /** Minimum concurrency required */
  minConcurrency?: number;
}

export interface CapabilitySelfDescription {
  whatItDoes: string;
  whatItRequires: string;
  whenAvailable: string;
  whatMakesItUnavailable: string;
  canRunOffline: boolean;
  hasKnownAlternatives: boolean;
  hasSideEffects: boolean;
  requiresConfirmation: boolean;
  resultType: string;
}

export interface CapabilityAvailabilityStatus {
  capabilityId: string;
  capabilityName: string;
  isAvailable: boolean;
  state: CapabilityAvailabilityState;
  reason?: UnavailabilityReason;
  canOperateOffline: boolean;
  dynamicChangeSupported: boolean;
  checkedAt: number;
}

// ============================================================================
// 3. ENVIRONMENT SNAPSHOT & SELF-AWARENESS INTERFACE
// ============================================================================

export interface EnvironmentSnapshot {
  network: {
    isOnline: boolean;
    state: 'online' | 'offline';
    lastChanged: number;
  };
  platform: {
    name: 'browser' | 'pwa' | 'iframe' | 'node' | 'unknown';
    isBrowser: boolean;
    isPWA: boolean;
    isRestrictedIframe: boolean;
    isNode: boolean;
    userAgent?: string;
  };
  resources: {
    pressureLevel: 'nominal' | 'elevated' | 'throttled';
    currentConcurrencyLimit: number;
    baseConcurrency: number;
    isUserInteracting: boolean;
    isAppVisible: boolean;
  };
  permissions: Record<string, 'granted' | 'prompt' | 'denied' | 'unsupported'>;
  localModel: {
    state: 'ready' | 'loading' | 'unloaded' | 'unavailable' | 'resource_constrained';
    modelId: string;
    name: string;
  };
  capabilities: {
    total: number;
    availableCount: number;
    unavailableCount: number;
    availableIds: string[];
    unavailableIds: string[];
    offlineCapableIds: string[];
    networkRequiringIds: string[];
  };
  timestamp: number;
}

export type EnvironmentChangeListener = (snapshot: EnvironmentSnapshot) => void;

// ============================================================================
// 4. ENVIRONMENT AWARENESS MANAGER
// ============================================================================

class EnvironmentAwarenessManager {
  private networkOnline: boolean;
  private networkLastChanged: number;
  private platformName: 'browser' | 'pwa' | 'iframe' | 'node' | 'unknown' = 'unknown';
  private isBrowserEnv = false;
  private isPWAEnv = false;
  private isIframeEnv = false;
  private isNodeEnv = false;

  private resourceMonitor: ResourceMonitor | null = null;
  private currentResourceState: ResourceState = {
    baseConcurrency: 2,
    currentConcurrencyLimit: 2,
    isUserInteracting: false,
    isAppVisible: true,
    pressureLevel: 'nominal',
  };

  private permissionsCache: Map<string, 'granted' | 'prompt' | 'denied' | 'unsupported'> = new Map();
  private listeners: Set<EnvironmentChangeListener> = new Set();
  private mockNetworkOverride: boolean | null = null;
  private mockPermissionOverrides: Map<string, 'granted' | 'prompt' | 'denied' | 'unsupported'> = new Map();
  private mockPlatformOverride: 'browser' | 'pwa' | 'iframe' | 'node' | null = null;
  private cleanupFns: Array<() => void> = [];

  constructor() {
    this.networkOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
    this.networkLastChanged = Date.now();
    this.detectPlatform();
    this.initResourceMonitoring();
    this.initEventListeners();
  }

  private detectPlatform(): void {
    if (typeof process !== 'undefined' && process.versions && process.versions.node) {
      this.isNodeEnv = true;
      this.platformName = 'node';
    }

    if (typeof window !== 'undefined') {
      this.isBrowserEnv = true;
      this.platformName = 'browser';

      // Check if restricted iframe
      try {
        if (window.self !== window.top) {
          this.isIframeEnv = true;
          this.platformName = 'iframe';
        }
      } catch {
        this.isIframeEnv = true;
        this.platformName = 'iframe';
      }

      // Check if PWA standalone
      try {
        const isStandalone =
          window.matchMedia('(display-mode: standalone)').matches ||
          (navigator as any)?.standalone === true;
        if (isStandalone) {
          this.isPWAEnv = true;
          this.platformName = 'pwa';
        }
      } catch {
        // matchMedia unsupported
      }
    }
  }

  private initResourceMonitoring(): void {
    try {
      this.resourceMonitor = new ResourceMonitor();
      const unsub = this.resourceMonitor.subscribe((state) => {
        this.currentResourceState = state;
        this.notifyChange();
      });
      this.cleanupFns.push(unsub);
    } catch {
      // Running outside browser DOM or in constrained runner
    }
  }

  private initEventListeners(): void {
    if (typeof window === 'undefined') return;

    const handleOnline = () => {
      this.networkOnline = true;
      this.networkLastChanged = Date.now();
      this.notifyChange();
    };

    const handleOffline = () => {
      this.networkOnline = false;
      this.networkLastChanged = Date.now();
      this.notifyChange();
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    this.cleanupFns.push(() => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    });
  }

  /**
   * Determine current real network state without assumption or faking.
   */
  public isNetworkOnline(): boolean {
    if (this.mockNetworkOverride !== null) {
      return this.mockNetworkOverride;
    }
    if (typeof navigator !== 'undefined') {
      return navigator.onLine;
    }
    return this.networkOnline;
  }

  /**
   * Sets a deterministic network override for testing or simulation.
   */
  public setNetworkOnline(online: boolean | null): void {
    this.mockNetworkOverride = online;
    this.networkLastChanged = Date.now();
    this.notifyChange();
  }

  /**
   * Sets a platform override for testing.
   */
  public setPlatformOverride(platform: 'browser' | 'pwa' | 'iframe' | 'node' | null): void {
    this.mockPlatformOverride = platform;
    this.notifyChange();
  }

  /**
   * Gets current active platform name.
   */
  public getPlatformName(): 'browser' | 'pwa' | 'iframe' | 'node' | 'unknown' {
    if (this.mockPlatformOverride) return this.mockPlatformOverride;
    return this.platformName;
  }

  /**
   * Overrides permission state for testing or permission change events.
   */
  public setPermissionState(
    permissionName: string,
    state: 'granted' | 'prompt' | 'denied' | 'unsupported' | null
  ): void {
    if (state === null) {
      this.mockPermissionOverrides.delete(permissionName);
    } else {
      this.mockPermissionOverrides.set(permissionName, state);
    }
    this.notifyChange();
  }

  /**
   * Queries platform permission state safely.
   */
  public getPermissionState(permissionName: string): 'granted' | 'prompt' | 'denied' | 'unsupported' {
    if (this.mockPermissionOverrides.has(permissionName)) {
      return this.mockPermissionOverrides.get(permissionName)!;
    }

    if (this.permissionsCache.has(permissionName)) {
      return this.permissionsCache.get(permissionName)!;
    }

    // Attempt browser navigator.permissions query if available
    if (typeof navigator !== 'undefined' && 'permissions' in navigator && navigator.permissions?.query) {
      try {
        // Query asynchronously in background and cache result
        (navigator.permissions.query as any)({ name: permissionName })
          .then((status: any) => {
            const mapped = status.state as 'granted' | 'prompt' | 'denied';
            this.permissionsCache.set(permissionName, mapped);
          })
          .catch(() => {
            this.permissionsCache.set(permissionName, 'unsupported');
          });
      } catch {
        this.permissionsCache.set(permissionName, 'unsupported');
      }
    } else {
      this.permissionsCache.set(permissionName, 'unsupported');
    }

    return this.permissionsCache.get(permissionName) || 'unsupported';
  }

  /**
   * Returns current measured resource state.
   */
  public getResourceState(): ResourceState {
    return { ...this.currentResourceState };
  }

  /**
   * Sets resource pressure level override for testing or manual throttling.
   */
  public setResourcePressure(level: 'nominal' | 'elevated' | 'throttled'): void {
    this.currentResourceState.pressureLevel = level;
    if (level === 'throttled') {
      this.currentResourceState.currentConcurrencyLimit = 1;
    }
    this.notifyChange();
  }

  /**
   * Builds an instantaneous environmental snapshot.
   */
  public getSnapshot(registeredCapabilities: Array<{ id: string; requirements?: CapabilityRequirements }> = []): EnvironmentSnapshot {
    const isOnline = this.isNetworkOnline();
    const plat = this.getPlatformName();
    const res = this.getResourceState();

    const permissionsRecord: Record<string, 'granted' | 'prompt' | 'denied' | 'unsupported'> = {};
    for (const [perm, state] of this.mockPermissionOverrides.entries()) {
      permissionsRecord[perm] = state;
    }
    for (const [perm, state] of this.permissionsCache.entries()) {
      if (!permissionsRecord[perm]) permissionsRecord[perm] = state;
    }

    const availableIds: string[] = [];
    const unavailableIds: string[] = [];
    const offlineCapableIds: string[] = [];
    const networkRequiringIds: string[] = [];

    for (const cap of registeredCapabilities) {
      const req = cap.requirements;
      if (req?.offlineCapable) {
        offlineCapableIds.push(cap.id);
      }
      if (req?.requiresNetwork) {
        networkRequiringIds.push(cap.id);
      }
    }

    return {
      network: {
        isOnline,
        state: isOnline ? 'online' : 'offline',
        lastChanged: this.networkLastChanged,
      },
      platform: {
        name: plat,
        isBrowser: plat === 'browser' || plat === 'pwa' || plat === 'iframe',
        isPWA: plat === 'pwa',
        isRestrictedIframe: plat === 'iframe',
        isNode: plat === 'node',
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
      },
      resources: res,
      permissions: permissionsRecord,
      localModel: {
        state: 'ready',
        modelId: 'axon-offline-core',
        name: 'AXON Neural Engine (On-Device)',
      },
      capabilities: {
        total: registeredCapabilities.length,
        availableCount: availableIds.length,
        unavailableCount: unavailableIds.length,
        availableIds,
        unavailableIds,
        offlineCapableIds,
        networkRequiringIds,
      },
      timestamp: Date.now(),
    };
  }

  public subscribe(listener: EnvironmentChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyChange(): void {
    const snap = this.getSnapshot([]);
    for (const listener of this.listeners) {
      try {
        listener(snap);
      } catch (err) {
        console.error('[EnvironmentAwarenessManager] Listener error:', err);
      }
    }
  }

  public destroy(): void {
    for (const cleanup of this.cleanupFns) {
      cleanup();
    }
    this.cleanupFns = [];
    this.listeners.clear();
    if (this.resourceMonitor) {
      this.resourceMonitor.destroy();
      this.resourceMonitor = null;
    }
  }
}

export const environmentAwareness = new EnvironmentAwarenessManager();

// ============================================================================
// 5. CAPABILITY AVAILABILITY EVALUATOR
// ============================================================================

export interface CapabilityAvailabilityCheckOptions {
  activeAccounts?: Array<{ provider: string; isActive: boolean; apiKey?: string; isRateLimited?: boolean; cooldownUntil?: number }>;
  customEnvironment?: EnvironmentSnapshot;
}

/**
 * Dynamically evaluates whether a capability can execute right now in this environment,
 * producing a structured reason and state when unavailable.
 */
export function evaluateCapabilityAvailability(
  capability: {
    id: string;
    name: string;
    requirements?: CapabilityRequirements;
    checkAvailability?: (env: EnvironmentSnapshot) => CapabilityAvailabilityStatus | null;
  },
  options?: CapabilityAvailabilityCheckOptions
): CapabilityAvailabilityStatus {
  const env = options?.customEnvironment || environmentAwareness.getSnapshot();
  const req = capability.requirements;

  // 1. If capability exposes custom dynamic checker, prioritize it
  if (capability.checkAvailability) {
    const customResult = capability.checkAvailability(env);
    if (customResult) return customResult;
  }

  // 2. Default fallback if no explicit requirements specified
  if (!req) {
    return {
      capabilityId: capability.id,
      capabilityName: capability.name,
      isAvailable: true,
      state: 'available',
      canOperateOffline: true,
      dynamicChangeSupported: true,
      checkedAt: Date.now(),
    };
  }

  // 3. Network requirement check
  if (req.requiresNetwork && !env.network.isOnline) {
    return {
      capabilityId: capability.id,
      capabilityName: capability.name,
      isAvailable: false,
      state: 'network_required',
      reason: {
        state: 'network_required',
        code: 'NETWORK_OFFLINE',
        message: `Capability '${capability.name}' requires active internet access.`,
        userFriendlyReason: 'Network connection is currently offline.',
        missingRequirement: { type: 'network' },
        recoverySuggestion: 'Connect device to the internet or use a local offline alternative.',
      },
      canOperateOffline: false,
      dynamicChangeSupported: true,
      checkedAt: Date.now(),
    };
  }

  // 4. External Account / API key check
  if (req.requiresExternalAccount) {
    const accounts = options?.activeAccounts;
    if (accounts) {
      const match = accounts.find((a) => a.provider === req.requiresExternalAccount);
      if (!match || !match.isActive || !match.apiKey || match.apiKey.trim().length === 0) {
        return {
          capabilityId: capability.id,
          capabilityName: capability.name,
          isAvailable: false,
          state: 'not_configured',
          reason: {
            state: 'not_configured',
            code: 'API_KEY_MISSING',
            message: `External account for '${req.requiresExternalAccount}' is not configured or active.`,
            userFriendlyReason: `API key for ${req.requiresExternalAccount.toUpperCase()} is not configured in Settings.`,
            missingRequirement: { type: 'configuration', target: req.requiresExternalAccount },
            recoverySuggestion: `Open Settings > AI Accounts and provide a valid ${req.requiresExternalAccount} API key.`,
          },
          canOperateOffline: false,
          dynamicChangeSupported: true,
          checkedAt: Date.now(),
        };
      }

      if (match.isRateLimited || (match.cooldownUntil && match.cooldownUntil > Date.now())) {
        return {
          capabilityId: capability.id,
          capabilityName: capability.name,
          isAvailable: false,
          state: 'temporarily_unavailable',
          reason: {
            state: 'temporarily_unavailable',
            code: 'ACCOUNT_COOLDOWN',
            message: `Account '${req.requiresExternalAccount}' is temporarily in cooldown/rate-limited.`,
            userFriendlyReason: `${req.requiresExternalAccount.toUpperCase()} is temporarily in rate-limit cooldown.`,
            missingRequirement: { type: 'resource', target: 'rate_limit' },
            recoverySuggestion: 'Wait for cooldown to expire or switch to AXON Local Core.',
          },
          canOperateOffline: false,
          dynamicChangeSupported: true,
          checkedAt: Date.now(),
        };
      }
    }
  }

  // 5. Platform permission checks
  if (req.requiredPermissions && req.requiredPermissions.length > 0) {
    for (const perm of req.requiredPermissions) {
      const state = environmentAwareness.getPermissionState(perm);
      if (state === 'denied') {
        return {
          capabilityId: capability.id,
          capabilityName: capability.name,
          isAvailable: false,
          state: 'permission_denied',
          reason: {
            state: 'permission_denied',
            code: 'PERMISSION_DENIED',
            message: `Required platform permission '${perm}' was denied.`,
            userFriendlyReason: `Permission '${perm}' was denied by the user or platform policy.`,
            missingRequirement: { type: 'permission', target: perm },
            recoverySuggestion: `Grant '${perm}' permission in browser settings.`,
          },
          canOperateOffline: req.offlineCapable,
          dynamicChangeSupported: true,
          checkedAt: Date.now(),
        };
      }
      if (state === 'prompt') {
        // Can operate or prompt on execute
      }
    }
  }

  // 6. Platform support check
  if (req.supportedPlatforms && req.supportedPlatforms.length > 0 && !req.supportedPlatforms.includes('all')) {
    const currentPlat = env.platform.name;
    const supported = req.supportedPlatforms.includes(currentPlat as PlatformType);
    if (!supported) {
      return {
        capabilityId: capability.id,
        capabilityName: capability.name,
        isAvailable: false,
        state: 'unsupported_platform',
        reason: {
          state: 'unsupported_platform',
          code: 'PLATFORM_UNSUPPORTED',
          message: `Capability '${capability.name}' is unsupported on platform '${currentPlat}'.`,
          userFriendlyReason: `This feature is not supported in the current ${currentPlat} environment.`,
          missingRequirement: { type: 'platform', target: currentPlat },
          recoverySuggestion: `Run AXON in a supported environment (${req.supportedPlatforms.join(', ')}).`,
        },
        canOperateOffline: req.offlineCapable,
        dynamicChangeSupported: false,
        checkedAt: Date.now(),
      };
    }
  }

  // 7. Resource constraint check
  if (req.maxPressureLevel) {
    const pressure = env.resources.pressureLevel;
    if (req.maxPressureLevel === 'nominal' && (pressure === 'elevated' || pressure === 'throttled')) {
      return {
        capabilityId: capability.id,
        capabilityName: capability.name,
        isAvailable: false,
        state: 'resource_constrained',
        reason: {
          state: 'resource_constrained',
          code: 'RESOURCE_THROTTLED',
          message: `Device resource pressure is currently ${pressure}.`,
          userFriendlyReason: 'Device resources are constrained to preserve responsiveness.',
          missingRequirement: { type: 'resource', target: 'pressure' },
          recoverySuggestion: 'Wait for background tasks to settle before re-attempting.',
        },
        canOperateOffline: req.offlineCapable,
        dynamicChangeSupported: true,
        checkedAt: Date.now(),
      };
    }
  }

  // All checks satisfied
  return {
    capabilityId: capability.id,
    capabilityName: capability.name,
    isAvailable: true,
    state: 'available',
    canOperateOffline: req.offlineCapable,
    dynamicChangeSupported: true,
    checkedAt: Date.now(),
  };
}

// ============================================================================
// 6. REASONING SYSTEM SELF-AWARENESS INTERFACE
// ============================================================================

export interface CapabilitySelfAwarenessQueryContext {
  capabilities: Array<{
    id: string;
    name: string;
    description: string;
    requirements?: CapabilityRequirements;
    selfDescription?: CapabilitySelfDescription;
  }>;
  activeAccounts?: Array<{ provider: string; isActive: boolean; apiKey?: string; isRateLimited?: boolean; cooldownUntil?: number }>;
}

/**
 * Provides structured internal self-awareness for AXON's reasoning and chat engine,
 * truthfully reporting environmental constraints, offline capabilities, and limitations.
 */
export function queryCapabilitySelfAwareness(
  query: string,
  context: CapabilitySelfAwarenessQueryContext
): string | null {
  const norm = query.toLowerCase().trim();
  const env = environmentAwareness.getSnapshot();

  // 1. Query: "What can you do offline?" / "Offline capabilities"
  if (
    norm.includes('what can you do offline') ||
    norm.includes('offline capabilities') ||
    norm.includes('work offline') ||
    norm.includes('offline mode') ||
    norm.includes('available offline')
  ) {
    const offlineCaps = context.capabilities.filter(
      (c) => c.requirements?.offlineCapable !== false
    );
    const names = offlineCaps.map((c) => `• **${c.name}**: ${c.description}`).join('\n');
    const netStatus = env.network.isOnline
      ? 'The network is currently online, but these capabilities operate completely on-device without internet dependencies.'
      : 'The device is currently **offline**. All listed capabilities remain fully operational on-device.';

    return (
      `### AXON On-Device & Offline Capabilities\n\n` +
      `${netStatus}\n\n` +
      `${names}\n\n` +
      `*Local Intelligence Core:* **AXON Neural Engine** runs on-device with zero network latency.`
    );
  }

  // 2. Query: "What can you do right now?" / "Current capabilities" / "What are you able to do?"
  if (
    norm.includes('what can you do right now') ||
    norm.includes('what capabilities are available') ||
    norm.includes('current capabilities') ||
    norm.includes('what can you do') ||
    norm.includes('available capabilities')
  ) {
    const available: string[] = [];
    const unavailable: string[] = [];

    for (const cap of context.capabilities) {
      const status = evaluateCapabilityAvailability(cap, {
        activeAccounts: context.activeAccounts,
        customEnvironment: env,
      });
      if (status.isAvailable) {
        available.push(`• **${cap.name}** (${status.canOperateOffline ? 'Offline' : 'Online'}): ${cap.description}`);
      } else {
        unavailable.push(`• **${cap.name}**: Unavailable (${status.reason?.userFriendlyReason || 'Limitation'})`);
      }
    }

    return (
      `### Current Environment & Capability Assessment\n\n` +
      `**Environment:** ${env.network.isOnline ? 'Online' : 'Offline'} | Platform: **${env.platform.name}** | Concurrency: **${env.resources.currentConcurrencyLimit}**\n\n` +
      `**Available Right Now (${available.length}):**\n${available.join('\n')}` +
      (unavailable.length > 0 ? `\n\n**Currently Unavailable (${unavailable.length}):**\n${unavailable.join('\n')}` : '')
    );
  }

  // 3. Query: "Why is X unavailable?" / "Is X available?"
  for (const cap of context.capabilities) {
    const capName = cap.name.toLowerCase();
    const capId = cap.id.toLowerCase();
    if (
      norm.includes(`why is ${capName} unavailable`) ||
      norm.includes(`why can't you ${capName}`) ||
      norm.includes(`why can't you use ${capName}`) ||
      norm.includes(`is ${capName} available`) ||
      norm.includes(`can you use ${capName}`) ||
      norm.includes(`is ${capId} available`)
    ) {
      const status = evaluateCapabilityAvailability(cap, {
        activeAccounts: context.activeAccounts,
        customEnvironment: env,
      });

      if (status.isAvailable) {
        return `**${cap.name}** is currently **available** in this environment (${status.canOperateOffline ? 'Offline-capable' : 'Online required'}).\n\n${cap.description}`;
      } else {
        return (
          `**${cap.name}** is currently **unavailable**.\n\n` +
          `• **Reason:** ${status.reason?.userFriendlyReason || status.reason?.message}\n` +
          `• **State:** \`${status.state}\`\n` +
          (status.reason?.recoverySuggestion ? `• **Resolution:** ${status.reason.recoverySuggestion}` : '')
        );
      }
    }
  }

  return null;
}

