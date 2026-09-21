import { ScreenId, ContextualMessageAction } from '../types';
import {
  discoverAvailableInterfaces,
  resolveInterfaceFromQuery,
  InterfaceMetadata,
} from './interfaceRegistry';
import { tryEvaluateMathExpression } from './storageChatHandler';

// ============================================================================
// 1. STATEMENT CLASSIFICATION & INTENT TYPES
// ============================================================================

/**
 * Statement classifications that distinguish between different user communicative acts.
 * AXON uses this to avoid treating every message containing command words as an instruction.
 */
export type StatementType =
  | 'conversational'
  | 'question'
  | 'explicit_instruction'
  | 'command'
  | 'confirmation'
  | 'correction'
  | 'refusal'
  | 'hypothetical'
  | 'suggestion'
  | 'request_for_alternatives'
  | 'ambiguous'
  | 'exceeds_capability';

/**
 * Purpose of an AXON response, ensuring every response actively advances the user's objective
 * rather than offering generic conversational filler.
 */
export type ResponsePurpose =
  | 'execute'
  | 'confirm'
  | 'clarify'
  | 'correct'
  | 'provide_solution'
  | 'provide_alternative'
  | 'report_result'
  | 'explain_limitation'
  | 'request_information'
  | 'provide_information';

/**
 * Execution policy for an action or intent.
 */
export type ExecutionPolicy = 'immediate' | 'suggestion' | 'confirmation';

/**
 * Structured intent definition holding capability, intent, target, parameters, and modifiers.
 */
export interface ResolvedIntent {
  statementType: StatementType;
  rawText: string;
  capabilityId?: string;
  intent: string;
  target?: string;
  parameters: Record<string, any>;
  modifiers: string[];
  executionPolicy: ExecutionPolicy;
  isExplicit: boolean;
  confidence: number;
  underlyingObjective?: string;
  preferredMethod?: string;
}

// ============================================================================
// 2. ACTION COMPOSITION MODEL & EXECUTION PLAN FOUNDATION
// ============================================================================

export type {
  ActionExecutionType,
  ActionDependencyCondition,
  ActionStatus,
  PlanStatus,
  ActionDependency,
  ActionNode,
  ActionExecutionPlan,
  PlanExecutionResult,
} from './actionPlan';

export {
  createSingleActionPlan,
  createSequentialPlan,
  createParallelPlan,
  createQueuedPlan,
  reorderPlanActions,
  setPlanPriority,
  cancelPlan,
  createRetryPlan,
  getLastExecutionPlan,
  setLastExecutionPlan,
  clearLastExecutionPlan,
  evaluateActionDependencies,
  executeActionNodeDirect,
  executeActionPlanSync,
  executeActionPlan,
  resolveActionPlanFromInput,
} from './actionPlan';

import type { ActionExecutionPlan } from './actionPlan';

// ============================================================================
// 3. ALTERNATIVE-SOLUTION & ROUTE RESOLUTION TYPES
// ============================================================================

export type RouteType = 'direct' | 'composed' | 'alternative' | 'partial' | 'limitation';

export interface AlternativeResolution {
  objective: string;
  requestedMethod?: string;
  routeType: RouteType;
  targetCapabilityId?: string;
  plan?: ActionExecutionPlan;
  explanation: string;
  actions?: ContextualMessageAction[];
  limitationDetails?: {
    limitation: string;
    cause: string;
    availableAlternatives: string[];
  };
}

// ============================================================================
// 4. EXTENSIBLE CAPABILITY REGISTRY INTERFACE
// ============================================================================

export interface CapabilityParameterSchema {
  type: 'string' | 'number' | 'boolean' | 'enum';
  required?: boolean;
  description?: string;
  options?: string[];
  defaultValue?: any;
}

export interface AlternativeMechanismDefinition {
  underlyingObjective: string;
  description: string;
  composedCapabilities?: string[];
  steps?: {
    capabilityId: string;
    intent: string;
    target?: string;
    parameters?: Record<string, any>;
    description: string;
  }[];
  actionsFactory?: (context?: any) => ContextualMessageAction[];
}

export interface CapabilityActionDefinition {
  intent: string;
  description: string;
  acceptedTargets?: string[];
  parametersSchema?: Record<string, CapabilityParameterSchema>;
  modifiers?: string[];
  requiresConfirmation?: boolean;
  supportedPolicies?: ExecutionPolicy[];
  alternativeMechanisms?: AlternativeMechanismDefinition[];
}

export interface CapabilityExecutionContext {
  currentScreen?: ScreenId;
  navigateTo?: (screen: ScreenId, options?: any) => void;
  settingsHandlers?: any;
  storageHandlers?: any;
  customHandlers?: Record<string, Function>;
}

export interface CapabilityExecutionResult {
  success: boolean;
  response: string;
  executed: boolean;
  purpose: ResponsePurpose;
  actions?: ContextualMessageAction[];
  targetScreen?: ScreenId;
  metadata?: Record<string, any>;
}

export interface SystemCapability {
  id: string;
  name: string;
  description: string;
  intents: CapabilityActionDefinition[];
  canHandleDirectly?: (intent: string, target?: string, params?: Record<string, any>) => boolean;
  resolveAlternative?: (objective: string, requestedMethod?: string) => AlternativeResolution | null;
  execute?: (
    intent: string,
    target: string | undefined,
    params: Record<string, any>,
    context: CapabilityExecutionContext
  ) => Promise<CapabilityExecutionResult> | CapabilityExecutionResult;
}

// ============================================================================
// 5. CAPABILITY REGISTRY STORE
// ============================================================================

class SystemCapabilityRegistry {
  private capabilities: Map<string, SystemCapability> = new Map();

  constructor() {
    this.registerBuiltInCapabilities();
  }

  public register(capability: SystemCapability): void {
    this.capabilities.set(capability.id, capability);
  }

  public unregister(capabilityId: string): void {
    this.capabilities.delete(capabilityId);
  }

  public get(capabilityId: string): SystemCapability | undefined {
    return this.capabilities.get(capabilityId);
  }

  public getAll(): SystemCapability[] {
    return Array.from(this.capabilities.values());
  }

  /**
   * Discovers which capability supports a specific intent or target.
   */
  public findCapabilityForIntent(intent: string, target?: string): SystemCapability | undefined {
    for (const cap of this.capabilities.values()) {
      const matchedIntent = cap.intents.find((i) => i.intent === intent);
      if (matchedIntent) {
        if (!target || !matchedIntent.acceptedTargets || matchedIntent.acceptedTargets.includes(target)) {
          return cap;
        }
      }
    }
    return undefined;
  }

  /**
   * Searches all registered capabilities for an alternative or composed route
   * that can achieve the user's underlying objective.
   */
  public searchAlternativeRoute(
    objective: string,
    requestedMethod?: string
  ): AlternativeResolution | null {
    const normObjective = objective.toLowerCase();

    // 1. First evaluate custom capability alternative resolvers
    for (const cap of this.capabilities.values()) {
      if (cap.resolveAlternative) {
        const res = cap.resolveAlternative(objective, requestedMethod);
        if (res) return res;
      }
    }

    // 2. Next check registered alternative mechanism declarations
    for (const cap of this.capabilities.values()) {
      for (const intentDef of cap.intents) {
        if (intentDef.alternativeMechanisms) {
          for (const mech of intentDef.alternativeMechanisms) {
            const mechObj = mech.underlyingObjective.toLowerCase();
            if (
              normObjective.includes(mechObj) ||
              mechObj.includes(normObjective)
            ) {
              const plan: ActionExecutionPlan = {
                id: `plan-${Date.now()}`,
                objective,
                type: (mech.steps && mech.steps.length > 1) ? 'sequence' : 'single',
                actions: (mech.steps || []).map((step, idx) => ({
                  id: `action-${idx + 1}`,
                  capabilityId: step.capabilityId,
                  intent: step.intent,
                  target: step.target,
                  parameters: step.parameters,
                  description: step.description,
                  status: 'created',
                })),
                status: 'created',
                dependencies: {},
                results: {},
                errors: {},
                createdAt: Date.now(),
              };

              return {
                objective,
                requestedMethod,
                routeType: mech.steps && mech.steps.length > 1 ? 'composed' : 'alternative',
                targetCapabilityId: cap.id,
                plan,
                explanation: mech.description,
                actions: mech.actionsFactory ? mech.actionsFactory() : undefined,
              };
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Registers built-in core capabilities grounded in the actual codebase.
   */
  private registerBuiltInCapabilities(): void {
    // 1. Workspace Navigation Capability
    this.register({
      id: 'workspace_navigation',
      name: 'Workspace Navigation',
      description: 'Navigates and opens registered interfaces, views, and tool suites.',
      intents: [
        {
          intent: 'open',
          description: 'Opens a target workspace interface or specialized utility.',
          supportedPolicies: ['immediate', 'suggestion', 'confirmation'],
        },
        {
          intent: 'navigate',
          description: 'Transitions to an interface view or sub-state.',
          supportedPolicies: ['immediate', 'suggestion'],
        },
      ],
      execute: (intent, target, params, context) => {
        if (!context.navigateTo || !target) {
          return {
            success: false,
            executed: false,
            purpose: 'explain_limitation',
            response: 'Navigation context is not available.',
          };
        }
        const resolution = resolveInterfaceFromQuery(target, context.currentScreen);
        if (resolution.match && resolution.match.route) {
          context.navigateTo(resolution.match.route as ScreenId, {
            screenState: resolution.match.subState,
          });
          return {
            success: true,
            executed: true,
            purpose: 'report_result',
            response: `Opened **${resolution.match.name}**.`,
            targetScreen: resolution.match.route as ScreenId,
          };
        }
        return {
          success: false,
          executed: false,
          purpose: 'clarify',
          response: `Could not find an interface matching "${target}".`,
        };
      },
    });

    // 2. Settings & Appearance Controller Capability
    this.register({
      id: 'settings_controller',
      name: 'Settings & Appearance Controller',
      description: 'Controls theme mode, accent colors, icon presets, sound effects, and notifications.',
      intents: [
        {
          intent: 'set_theme',
          description: 'Switches theme between dark and light modes.',
          parametersSchema: {
            mode: { type: 'enum', required: true, options: ['dark', 'light'] },
          },
          supportedPolicies: ['immediate'],
        },
        {
          intent: 'set_accent_color',
          description: 'Updates workspace accent color.',
          parametersSchema: {
            color: {
              type: 'enum',
              required: true,
              options: ['blue', 'emerald', 'purple', 'amber', 'orange', 'red', 'rose', 'cyan', 'monochrome'],
            },
          },
          supportedPolicies: ['immediate'],
        },
        {
          intent: 'configure_appearance',
          description: 'Configures visual presentation and component styling.',
          alternativeMechanisms: [
            {
              underlyingObjective: 'change appearance of action menu or interface',
              description:
                'AXON interface appearance is governed by theme mode and accent color configurations in the Settings Controller.',
              actionsFactory: () => [
                {
                  label: 'Set Dark Theme',
                  actionText: 'set theme to dark',
                  description: 'Switch to Dark Mode',
                  intent: 'set_theme',
                  variant: 'default',
                },
                {
                  label: 'Set Emerald Accent',
                  actionText: 'set accent color to emerald',
                  description: 'Apply Emerald accent',
                  intent: 'set_accent_color',
                  variant: 'secondary',
                },
                {
                  label: 'Open Settings',
                  actionText: '/open settings',
                  destinationId: 'settings',
                  targetId: 'settings',
                  description: 'Open Settings to view all options',
                  intent: 'open',
                  variant: 'default',
                },
              ],
            },
          ],
        },
      ],
      resolveAlternative: (objective, requestedMethod) => {
        const norm = objective.toLowerCase();
        if (
          norm.includes('appearance') ||
          norm.includes('look and feel') ||
          norm.includes('style the menu') ||
          norm.includes('theme color') ||
          norm.includes('action menu appearance')
        ) {
          return {
            objective,
            requestedMethod,
            routeType: 'direct',
            targetCapabilityId: 'settings_controller',
            explanation:
              'Interface appearance is configured through the Settings Controller via Theme Mode and Accent Colors.',
            actions: [
              {
                label: 'Set Dark Theme',
                actionText: 'set theme to dark',
                description: 'Switch to Dark Mode',
                intent: 'set_theme',
                variant: 'default',
              },
              {
                label: 'Set Emerald Accent',
                actionText: 'set accent color to emerald',
                description: 'Apply Emerald accent',
                intent: 'set_accent_color',
                variant: 'secondary',
              },
              {
                label: 'Open Settings',
                actionText: '/open settings',
                destinationId: 'settings',
                targetId: 'settings',
                description: 'Configure appearance in Settings',
                intent: 'open',
                variant: 'default',
              },
            ],
          };
        }
        return null;
      },
      execute: (intent, target, params, context) => {
        if (intent === 'set_theme') {
          const mode = params?.mode || (target && target.includes('dark') ? 'dark' : 'light');
          if (context.settingsHandlers?.setThemeMode) {
            context.settingsHandlers.setThemeMode(mode);
          }
          return {
            success: true,
            executed: true,
            purpose: 'report_result',
            response: `Switched theme to **${mode}** mode.`,
            metadata: { themeMode: mode },
          };
        }
        if (intent === 'set_accent_color') {
          const color = params?.color || target || 'emerald';
          if (context.settingsHandlers?.setAccentColor) {
            context.settingsHandlers.setAccentColor(color);
          }
          return {
            success: true,
            executed: true,
            purpose: 'report_result',
            response: `Updated accent color to **${color}**.`,
            metadata: { accentColor: color },
          };
        }
        if (intent === 'configure_appearance') {
          if (context.navigateTo) {
            context.navigateTo('settings');
            return {
              success: true,
              executed: true,
              purpose: 'report_result',
              response: 'Opened **Settings**.',
              targetScreen: 'settings',
            };
          }
        }
        return {
          success: false,
          executed: false,
          purpose: 'explain_limitation',
          response: `Unsupported settings intent "${intent}".`,
        };
      },
    });

    // 3. Interface Capture & Document Export Capability
    this.register({
      id: 'interface_capture',
      name: 'Interface Capture & Document Generation',
      description: 'Captures visual layout states, analyzes layout segments, and generates PDF export bundles.',
      intents: [
        {
          intent: 'capture_interface',
          description: 'Captures active workspace interface visual frame.',
          supportedPolicies: ['immediate'],
        },
        {
          intent: 'export_pdf',
          description: 'Compiles layout screenshots and documentation into a downloadable PDF document.',
          supportedPolicies: ['immediate'],
        },
      ],
      resolveAlternative: (objective, requestedMethod) => {
        const norm = objective.toLowerCase();
        // User wants to print, backup views, download screenshots, or export interface bundle
        if (
          norm.includes('print') ||
          norm.includes('pdf export') ||
          norm.includes('export interfaces') ||
          norm.includes('save views') ||
          norm.includes('document screens')
        ) {
          return {
            objective,
            requestedMethod,
            routeType: 'composed',
            targetCapabilityId: 'interface_capture',
            explanation:
              'Direct physical printing is handled by capturing active interface layouts and generating a compiled PDF document via Interface Capture.',
            actions: [
              {
                label: 'Capture Current Interface',
                actionText: 'capture this interface',
                description: 'Capture screenshot of active view',
                intent: 'capture_interface',
                variant: 'default',
              },
              {
                label: 'Open Interface Capture',
                actionText: '/open capture',
                destinationId: 'capture',
                targetId: 'capture',
                description: 'View capture gallery and generate PDF',
                intent: 'open',
                variant: 'secondary',
              },
            ],
          };
        }
        return null;
      },
      execute: (intent, target, params, context) => {
        if (context.navigateTo) {
          context.navigateTo('tool_interface_capture');
          return {
            success: true,
            executed: true,
            purpose: 'report_result',
            response: 'Opened **Interface Capture**.',
            targetScreen: 'tool_interface_capture',
          };
        }
        return {
          success: false,
          executed: false,
          purpose: 'explain_limitation',
          response: 'Navigation context is not available.',
        };
      },
    });

    // 4. Storage Diagnostics & Reallocation Capability
    this.register({
      id: 'storage_diagnostics',
      name: 'Storage & Memory Diagnostics',
      description: 'Monitors asset quota, clears asset cache, and reallocates storage capacity.',
      intents: [
        {
          intent: 'inspect_storage',
          description: 'Inspects persistent asset manifest and memory usage.',
          supportedPolicies: ['immediate'],
        },
        {
          intent: 'reallocate_storage',
          description: 'Adjusts disk allocation quotas for workspace assets.',
          supportedPolicies: ['immediate'],
        },
      ],
      resolveAlternative: (objective, requestedMethod) => {
        const norm = objective.toLowerCase();
        if (
          norm.includes('free space') ||
          norm.includes('disk space') ||
          norm.includes('clear cache') ||
          norm.includes('storage full') ||
          norm.includes('clean memory')
        ) {
          return {
            objective,
            requestedMethod,
            routeType: 'direct',
            targetCapabilityId: 'storage_diagnostics',
            explanation:
              'Storage capacity and asset disk allocations are managed via Storage Diagnostics and reallocation tools.',
            actions: [
              {
                label: 'Open Storage Diagnostics',
                actionText: '/open storage',
                destinationId: 'storage',
                targetId: 'storage',
                description: 'Inspect storage quota and allocations',
                intent: 'open',
                variant: 'default',
              },
            ],
          };
        }
        return null;
      },
      execute: (intent, target, params, context) => {
        if (context.navigateTo) {
          context.navigateTo('storage');
          return {
            success: true,
            executed: true,
            purpose: 'report_result',
            response: 'Opened **Storage & Diagnostics**.',
            targetScreen: 'storage',
          };
        }
        return {
          success: false,
          executed: false,
          purpose: 'explain_limitation',
          response: 'Navigation context is not available.',
        };
      },
    });

    // 5. Offline Math & Calculation Engine
    this.register({
      id: 'math_calculator',
      name: 'Offline Math Engine',
      description: 'Evaluates arithmetic expressions, percentages, and scientific calculations offline.',
      intents: [
        {
          intent: 'calculate',
          description: 'Computes numerical and mathematical results.',
          supportedPolicies: ['immediate'],
        },
      ],
      execute: (intent, target, params, context) => {
        const expr = params?.expression || target || '';
        const result = tryEvaluateMathExpression(expr);
        if (result) {
          return {
            success: true,
            executed: true,
            purpose: 'report_result',
            response: result,
            metadata: { calculation: result },
          };
        }
        return {
          success: false,
          executed: false,
          purpose: 'explain_limitation',
          response: `Could not evaluate math expression "${expr}".`,
        };
      },
    });

    // 6. Automation & Custom Script Runner
    this.register({
      id: 'automation_runner',
      name: 'Automation & Extension Runner',
      description: 'Executes user-defined automation rules, run code scripts, and custom slash commands.',
      intents: [
        {
          intent: 'run_custom_command',
          description: 'Dispatches registered /status and custom slash scripts.',
          supportedPolicies: ['immediate'],
        },
      ],
      execute: (intent, target, params, context) => {
        return {
          success: true,
          executed: true,
          purpose: 'report_result',
          response: `Automation instruction "${target || intent}" processed.`,
        };
      },
    });
  }
}

export const systemCapabilityRegistry = new SystemCapabilityRegistry();

// ============================================================================
// 6. STATEMENT & INTENT CLASSIFICATION ENGINE
// ============================================================================

/**
 * Classifies an incoming user message into a distinct statement type.
 * Ensures questions, hypothetical statements, negated commands, and corrections
 * are never accidentally treated as executable instructions.
 */
export function classifyStatement(text: string): StatementType {
  const norm = text.trim();
  const lower = norm.toLowerCase();

  // 1. Explicit command syntax
  if (/^\/[a-z0-9_-]+/i.test(lower)) {
    return 'command';
  }

  // 2. Explicit "run" or "execute" syntax
  if (/^(?:\/run\b|run\s+command\b|execute\s+command\b|run\b|execute\b)(?::|\s+)/i.test(lower)) {
    // Distinguish if it's a question about the run command: "what does the run command do?"
    if (
      /^(?:what|how|why|where|when|can\s+you|could\s+you|explain)\b/i.test(lower) ||
      lower.endsWith('?')
    ) {
      return 'question';
    }
    // Distinguish if it's a hypothetical statement: "if I run this, what happens?"
    if (/^(?:if\s+i|what\s+if|assuming\s+i)\b/i.test(lower)) {
      return 'hypothetical';
    }
    // Distinguish if it's a negated instruction: "don't run this"
    if (/^(?:don'?t|do\s+not|never)\s+(?:run|execute)\b/i.test(lower)) {
      return 'refusal';
    }
    return 'command';
  }

  // 3. Negated instruction / refusal / prohibition
  if (
    /^(?:don'?t|do\s+not|never|stop|cancel|quit|abort)\s+(?:run|open|execute|change|navigate|start|delete|modify)\b/i.test(
      lower
    ) ||
    /^(?:no|nope|nah|nevermind|never\s+mind|not\s+this|not\s+that|no[,\s]+not\s+this|no[,\s]+not\s+that)[!.?,]*$/i.test(
      lower
    )
  ) {
    return 'refusal';
  }

  // 4. Correction intent: "no, I meant Settings", "no, not that", "actually open tools", "instead go to code"
  if (
    /^(?:no|nope|nah)[,\s]+(?:i\s+meant|actually|instead|not\s+that|not\s+this)[,\s]+/i.test(lower) ||
    /^(?:actually|instead)[,\s]+/i.test(lower) ||
    /^(?:i\s+meant\s+|not\s+.+?[,\s]+(?:but|open|i\s+meant)\s+)/i.test(lower)
  ) {
    return 'correction';
  }

  // 5. Hypothetical statements
  if (
    /^(?:if\s+i|what\s+if|suppose\s+i|assuming\s+i|what\s+would\s+happen\s+if|in\s+case\s+i)\b/i.test(
      lower
    )
  ) {
    return 'hypothetical';
  }

  // 6. Questions
  if (
    lower.endsWith('?') ||
    /^(?:what|how|why|who|where|when|which|is\s+there|are\s+there|can\s+i|could\s+i|would\s+it|does\s+axon|do\s+you)\b/i.test(
      lower
    )
  ) {
    // Check if it's a request for alternatives: "is there another way?", "what are the alternatives?"
    if (
      lower.includes('another way') ||
      lower.includes('alternative') ||
      lower.includes('other options') ||
      lower.includes('what else can i')
    ) {
      return 'request_for_alternatives';
    }
    return 'question';
  }

  // 7. Confirmations / selections
  if (
    /^(?:yes|yeah|yep|yup|sure|okay|ok|correct|right|that'?s\s+right|that\s+one|number\s+[1-9]|[1-9](?:st|nd|rd|th)?(?:\s+one)?|proceed|do\s+it)[!.?,]*$/i.test(
      lower
    )
  ) {
    return 'confirmation';
  }

  // 8. Suggestions / proposals
  if (/^(?:maybe\s+we\s+could|we\s+could|perhaps\s+we|how\s+about\s+we)\b/i.test(lower)) {
    return 'suggestion';
  }

  // 9. Check if request clearly exceeds directly available capability
  // e.g. sending email, printing to a physical hardware printer, external telephony, ordering food
  if (
    /\b(?:send\s+(?:an?\s+)?email|email\s+(?:this|to)|sms|text\s+message|call\s+phone|physical\s+printer|print\s+to\s+paper|hardware\s+device)\b/i.test(
      lower
    )
  ) {
    return 'exceeds_capability';
  }

  // 10. Explicit instructions / imperatives (including appearance and setting configuration requests)
  if (
    /^(?:please\s+)?(?:open(?:\s+up)?|go\s+to|navigate\s+to|show\s+me|switch\s+to|set\s+|change\s+|reset\s+|capture\s+|export\s+|calculate\s+)\b/i.test(
      lower
    ) ||
    /\b(?:change|customize|modify|adjust|update|style)\s+(?:the\s+)?(?:appearance|theme|look|color|styling)\b/i.test(
      lower
    )
  ) {
    // Check if critical parameters are missing or ambiguous
    if (/^(?:open|navigate|go\s+to)$/i.test(lower)) {
      return 'ambiguous';
    }
    return 'explicit_instruction';
  }

  // 11. Conversational
  return 'conversational';
}

// ============================================================================
// 7. PURPOSE-DRIVEN INTENT RESOLVER
// ============================================================================

/**
 * Resolves a user's statement into a structured intent, separating the underlying
 * objective from the requested method, and evaluating direct vs. alternative capability.
 */
export function resolveUserIntent(
  text: string,
  currentScreen?: ScreenId,
  hasPendingInteraction: boolean = false
): ResolvedIntent {
  const norm = text.trim();
  const lower = norm.toLowerCase();
  const statementType = classifyStatement(norm);

  // 1. Correction
  if (statementType === 'correction' || (hasPendingInteraction && /^(?:no|actually|instead|i\s+meant)/i.test(lower))) {
    let correctedTarget = '';
    const meantMatch = lower.match(/(?:i\s+meant|actually|instead|open)\s+([a-zA-Z0-9_\s-]+)/i);
    if (meantMatch && meantMatch[1]) {
      correctedTarget = meantMatch[1].trim();
    } else {
      // e.g. "No, Settings"
      const simpleMatch = lower.match(/^(?:no|nope)[,\s]+([a-zA-Z0-9_\s-]+)$/i);
      if (simpleMatch && simpleMatch[1]) {
        correctedTarget = simpleMatch[1].trim();
      }
    }

    return {
      statementType: 'correction',
      rawText: norm,
      intent: 'correct',
      target: correctedTarget,
      parameters: { correctedTarget },
      modifiers: [],
      executionPolicy: 'immediate',
      isExplicit: true,
      confidence: 0.95,
      underlyingObjective: correctedTarget ? `Navigate to ${correctedTarget}` : 'Correct previous intent',
    };
  }

  // 2. Command / Run instruction
  if (statementType === 'command') {
    // Check for explicit "run ..." form
    const runMatch = lower.match(
      /^(?:\/run\b|run\s+command\b|run\b|execute\s+command\b|execute\b)(?::|\s+)\s*(.+)$/i
    );
    if (runMatch && runMatch[1]) {
      const inner = runMatch[1].trim();
      return {
        statementType: 'command',
        rawText: norm,
        intent: 'execute',
        target: inner,
        parameters: { rawInstruction: inner },
        modifiers: ['run_authorized'],
        executionPolicy: 'immediate',
        isExplicit: true,
        confidence: 0.98,
        underlyingObjective: inner,
      };
    }

    // Slash command
    const slashMatch = lower.match(/^\/([a-z0-9_-]+)(?:\s+(.*))?$/i);
    if (slashMatch) {
      const cmd = slashMatch[1];
      const arg = (slashMatch[2] || '').trim();
      return {
        statementType: 'command',
        rawText: norm,
        capabilityId: cmd === 'open' ? 'workspace_navigation' : cmd,
        intent: cmd,
        target: arg,
        parameters: { argument: arg },
        modifiers: [],
        executionPolicy: 'immediate',
        isExplicit: true,
        confidence: 1.0,
        underlyingObjective: arg ? `${cmd} ${arg}` : cmd,
      };
    }
  }

  // 3. Question about a command: e.g. "What does the run command do?", "How does the open command work?", "What does /open do?"
  if (
    statementType === 'question' &&
    /\b(?:run\s+command|open\s+command|execute\s+command|\/run\b|\/open\b)\b/i.test(lower)
  ) {
    const isRun = /\b(?:run\s+command|\/run\b)\b/i.test(lower);
    return {
      statementType: 'question',
      rawText: norm,
      intent: 'explain_command',
      target: isRun ? 'run' : 'open',
      parameters: {},
      modifiers: [],
      executionPolicy: 'immediate',
      isExplicit: false,
      confidence: 0.9,
      underlyingObjective: `Learn about ${isRun ? 'run' : 'open'} command semantics`,
    };
  }

  // 4. Hypothetical statement: e.g. "If I run this, what happens?"
  if (statementType === 'hypothetical') {
    return {
      statementType: 'hypothetical',
      rawText: norm,
      intent: 'evaluate_hypothetical',
      parameters: {},
      modifiers: [],
      executionPolicy: 'immediate',
      isExplicit: false,
      confidence: 0.85,
      underlyingObjective: 'Understand consequences of potential action',
    };
  }

  // 5. Refusal / Prohibition: e.g. "Don't run this."
  if (statementType === 'refusal') {
    return {
      statementType: 'refusal',
      rawText: norm,
      intent: 'prohibit_action',
      parameters: {},
      modifiers: [],
      executionPolicy: 'immediate',
      isExplicit: true,
      confidence: 0.95,
      underlyingObjective: 'Prevent or cancel command execution',
    };
  }

  // 6. Request exceeds capability
  if (statementType === 'exceeds_capability') {
    return {
      statementType: 'exceeds_capability',
      rawText: norm,
      intent: 'unsupported_operation',
      parameters: {},
      modifiers: [],
      executionPolicy: 'immediate',
      isExplicit: true,
      confidence: 0.9,
      underlyingObjective: norm,
      preferredMethod: 'external_unsupported_service',
    };
  }

  // 7. Explicit instruction / Imperative navigation or setting change
  if (statementType === 'explicit_instruction') {
    // Check navigation
    const navMatch = lower.match(
      /^(?:please\s+)?(?:open(?:\s+up)?|go\s+to|navigate\s+to|show(?:\s+me)?)\s+(.+)$/i
    );
    if (navMatch && navMatch[1]) {
      const target = navMatch[1].trim();
      return {
        statementType: 'explicit_instruction',
        rawText: norm,
        capabilityId: 'workspace_navigation',
        intent: 'open',
        target,
        parameters: { target },
        modifiers: [],
        executionPolicy: 'suggestion',
        isExplicit: false,
        confidence: 0.9,
        underlyingObjective: `Navigate to ${target}`,
      };
    }

    // Check appearance change: "I want to change the appearance of the action menu"
    if (
      lower.includes('change the appearance') ||
      lower.includes('change appearance') ||
      lower.includes('customize appearance') ||
      lower.includes('change look')
    ) {
      return {
        statementType: 'explicit_instruction',
        rawText: norm,
        capabilityId: 'settings_controller',
        intent: 'configure_appearance',
        target: 'appearance',
        parameters: {},
        modifiers: [],
        executionPolicy: 'immediate',
        isExplicit: false,
        confidence: 0.92,
        underlyingObjective: 'Customize interface appearance',
      };
    }
  }

  // Default: conversational / general statement
  return {
    statementType,
    rawText: norm,
    intent: 'converse',
    parameters: {},
    modifiers: [],
    executionPolicy: 'immediate',
    isExplicit: false,
    confidence: 0.5,
    underlyingObjective: norm,
  };
}

// ============================================================================
// 8. MEANINGFUL RESPONSE FORMULATION & PROBLEM SOLVING ENGINE
// ============================================================================

export interface MeaningfulEvaluationResult {
  handled: boolean;
  executed: boolean;
  purpose: ResponsePurpose;
  response: string;
  commandName?: string;
  actions?: ContextualMessageAction[];
  targetScreen?: ScreenId;
  modelUsed?: string;
}

/**
 * Resolves a user's objective using AXON's capability-aware problem solving principles:
 * - Direct capability: Execute or confirm according to policy
 * - Indirect capability: Compose existing capabilities to achieve objective (A -> B -> C)
 * - Genuine limitation: limitation -> analysis -> viable alternative -> forward action
 * - Meaningful interaction: Avoid redundant repetition, paraphrase, or empty filler
 */
export function evaluateMeaningfulInteraction(
  resolvedIntent: ResolvedIntent,
  context: CapabilityExecutionContext
): MeaningfulEvaluationResult | null {
  // 1. Questions about commands (e.g. "What does the run command do?")
  if (resolvedIntent.intent === 'explain_command') {
    return {
      handled: true,
      executed: false,
      purpose: 'provide_information',
      commandName: 'help',
      response:
        'The `run` instruction explicitly authorizes immediate command execution in AXON without presenting a confirmation or suggestion prompt.\n\nFor example, typing `run open settings` or `run calculator` navigates directly to that interface.',
      modelUsed: 'AXON Capability Intelligence',
    };
  }

  // 2. Hypothetical statement (e.g. "If I run this, what happens?")
  if (resolvedIntent.statementType === 'hypothetical') {
    return {
      handled: true,
      executed: false,
      purpose: 'provide_information',
      commandName: 'hypothetical',
      response:
        'Executing a command directly switches active workspace views or applies configured parameters immediately. No destructive actions are performed without explicit confirmation.',
      modelUsed: 'AXON Capability Intelligence',
    };
  }

  // 3. Refusal / Prohibition (e.g. "Don't run this.")
  if (resolvedIntent.statementType === 'refusal') {
    return {
      handled: true,
      executed: false,
      purpose: 'report_result',
      commandName: 'prohibition',
      response: 'Understood. Execution cancelled and no action will be taken.',
      modelUsed: 'AXON Capability Intelligence',
    };
  }

  // 4. Request that exceeds directly available capability (e.g. "Send an email to...")
  if (resolvedIntent.statementType === 'exceeds_capability') {
    // Look for valid alternative route in registered capabilities
    const alt = systemCapabilityRegistry.searchAlternativeRoute(
      resolvedIntent.underlyingObjective || resolvedIntent.rawText,
      resolvedIntent.preferredMethod
    );

    if (alt) {
      return {
        handled: true,
        executed: false,
        purpose: 'provide_alternative',
        commandName: 'alternative_route',
        response: `${alt.explanation}`,
        actions: alt.actions,
        modelUsed: 'AXON Problem Solver',
      };
    }

    // Genuine limitation: identify limitation -> explain cause -> offer genuine options
    return {
      handled: true,
      executed: false,
      purpose: 'explain_limitation',
      commandName: 'capability_limit',
      response:
        `AXON operates in a secure, local client-side sandbox and cannot send outbound external transmissions (such as emails or SMS) directly.\n\n` +
        `However, you can compile and export your workspace data as a document using Interface Capture (\`/open capture\`) or copy your notes directly to share them with your team.`,
      actions: [
        {
          label: 'Open Interface Capture',
          actionText: '/open capture',
          destinationId: 'capture',
          targetId: 'capture',
          description: 'Export workspace views as PDF',
          intent: 'open',
          variant: 'default',
        },
        {
          label: 'Open Project Notes',
          actionText: '/open notes',
          destinationId: 'notes',
          targetId: 'notes',
          description: 'Access project notes',
          intent: 'open',
          variant: 'secondary',
        },
      ],
      modelUsed: 'AXON Capability Intelligence',
    };
  }

  // 5. Meaningful Appearance Configuration
  // e.g. "I want to change the appearance of the action menu"
  if (
    resolvedIntent.capabilityId === 'settings_controller' &&
    resolvedIntent.intent === 'configure_appearance'
  ) {
    return {
      handled: true,
      executed: false,
      purpose: 'provide_solution',
      commandName: 'settings',
      response:
        `AXON interface appearance is customized through the **Settings Controller**.\n\n` +
        `Available options:\n` +
        `• **Theme Mode**: Dark Mode or Light Mode\n` +
        `• **Accent Colors**: Blue, Emerald, Purple, Amber, Orange, Red, Rose, Cyan, Monochrome\n` +
        `• **Interface Styling**: App icon presets, avatar presets, and typography case\n\n` +
        `You can apply an option directly (e.g. *"set theme to dark"* or *"set accent color to emerald"*), or open Settings to configure them visually.`,
      actions: [
        {
          label: 'Set Dark Theme',
          actionText: 'set theme to dark',
          description: 'Apply Dark Mode',
          intent: 'set_theme',
          variant: 'default',
        },
        {
          label: 'Set Emerald Accent',
          actionText: 'set accent color to emerald',
          description: 'Apply Emerald accent',
          intent: 'set_accent_color',
          variant: 'secondary',
        },
        {
          label: 'Open Settings',
          actionText: '/open settings',
          destinationId: 'settings',
          targetId: 'settings',
          description: 'Open visual settings panel',
          intent: 'open',
          variant: 'default',
        },
      ],
      modelUsed: 'AXON Settings Controller',
    };
  }

  return null;
}
